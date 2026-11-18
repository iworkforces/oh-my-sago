import type { Plugin } from "@opencode/plugin";
import type { SessionInfo } from "@opencode/client";
import type { Event, EventTodoUpdated, SessionMessagesResponse } from "@opencode-ai/sdk";
import type { Todo } from "@opencode-ai/sdk/v2";
import { ErrorName, LegacyEventType, SessionEventType, SessionStatusKind } from "../enums.js";
import { BridgeError, assertNever } from "./errors.js";
import { legacyError, legacyMessages } from "./messages.js";
import { type SessionRetries, legacySession, listSessions } from "./sessions.js";
import { recordTodos } from "./todos.js";

const types = [
  SessionEventType.Created,
  SessionEventType.Deleted,
  SessionEventType.Renamed,
  SessionEventType.Moved,
  SessionEventType.AgentSelected,
  SessionEventType.ModelSelected,
  SessionEventType.MetadataUpdated,
  SessionEventType.Permissions,
  SessionEventType.Archived,
  SessionEventType.Unarchived,
  SessionEventType.ExecutionStarted,
  SessionEventType.ExecutionSucceeded,
  SessionEventType.ExecutionFailed,
  SessionEventType.ExecutionInterrupted,
  SessionEventType.InboxDelivered,
  SessionEventType.Synthetic,
  SessionEventType.StepStarted,
  SessionEventType.StepEnded,
  SessionEventType.StepFailed,
  SessionEventType.TextDelta,
  SessionEventType.TextEnded,
  SessionEventType.ReasoningDelta,
  SessionEventType.ReasoningEnded,
  SessionEventType.ToolCalled,
  SessionEventType.ToolProgress,
  SessionEventType.ToolSuccess,
  SessionEventType.ToolFailed,
  SessionEventType.RetryScheduled,
  SessionEventType.CompactionEnded,
] as const;

/** v1 todos carry no `id`; OmO keys them by content and priority. */
export type LegacyEvent =
  | Exclude<Event, EventTodoUpdated>
  | { type: typeof LegacyEventType.TodoUpdated; properties: { sessionID: string; todos: Todo[] } };

export interface LegacyEventSink {
  // Method syntax keeps OmO's `Hooks`, typed against the id-carrying todo, assignable here.
  event?(input: { event: LegacyEvent }): Promise<void>;
}

export interface ClientEvents {
  start(hooks: LegacyEventSink): Promise<void>;
  dispose(): Promise<void>;
}

export function clientEvents(context: Plugin.Context, retries: SessionRetries): ClientEvents {
  const controller = new AbortController();
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, SessionMessagesResponse>();
  let loop: Promise<void> | undefined;
  let disposed = false;
  return {
    async start(hooks: LegacyEventSink): Promise<void> {
      if (disposed) throw new BridgeError(409, "The client bridge is disposed");
      if (loop !== undefined)
        throw new BridgeError(409, "The client bridge event subscription already started");
      const signal = controller.signal;
      const options = { signal };
      const iterator = context.event.subscribe({ types, signal })[Symbol.asyncIterator]();
      const first = iterator.next();
      const seeded = listSessions(
        context,
        new Request("http://omsago.invalid/session", { signal }),
      ).then((records) => {
        for (const session of records) sessions.set(session.id, session);
      });
      const stopped = (error: unknown): boolean =>
        signal.aborted &&
        (error === signal.reason || (error instanceof Error && error.name === ErrorName.Abort));
      const emit = async (event: LegacyEvent): Promise<void> => {
        try {
          await hooks.event?.({ event });
        } catch (error) {
          if (stopped(error)) throw error;
          console.error("Client bridge event handler failed", { type: event.type, error });
        }
      };
      const status = (
        sessionID: string,
        type: typeof SessionStatusKind.Busy | typeof SessionStatusKind.Idle,
      ): Promise<void> =>
        emit({ type: LegacyEventType.SessionStatus, properties: { sessionID, status: { type } } });
      type NativeEvent = Exclude<Awaited<typeof first>, { done: true }>["value"];
      const handle = async (event: NativeEvent): Promise<void> => {
        const { sessionID } = event.data;
        if (event.type === SessionEventType.Deleted) {
          const session = sessions.get(sessionID);
          sessions.delete(sessionID);
          messages.delete(sessionID);
          retries.clear(sessionID);
          if (session === undefined)
            throw new BridgeError(500, `Deleted session ${sessionID} has no observed snapshot`);
          await emit({
            type: LegacyEventType.SessionDeleted,
            properties: { info: legacySession(session) },
          });
          return;
        }
        if (
          event.type === SessionEventType.ExecutionSucceeded ||
          event.type === SessionEventType.ExecutionFailed ||
          event.type === SessionEventType.ExecutionInterrupted
        )
          retries.clear(sessionID);
        const [session, records] = await Promise.all([
          context.session.get({ sessionID }, options),
          context.session.context({ sessionID }, options),
        ]);
        sessions.set(sessionID, session);
        const settled: LegacyEvent[] = [];
        switch (event.type) {
          case SessionEventType.Created:
            await emit({
              type: LegacyEventType.SessionCreated,
              properties: { info: legacySession(session) },
            });
            break;
          case SessionEventType.Renamed:
          case SessionEventType.Moved:
          case SessionEventType.AgentSelected:
          case SessionEventType.ModelSelected:
          case SessionEventType.MetadataUpdated:
          case SessionEventType.Permissions:
          case SessionEventType.Archived:
          case SessionEventType.Unarchived:
            await emit({
              type: LegacyEventType.SessionUpdated,
              properties: { info: legacySession(session) },
            });
            break;
          case SessionEventType.ExecutionStarted:
            await status(sessionID, SessionStatusKind.Busy);
            break;
          case SessionEventType.ExecutionFailed:
            await emit({
              type: LegacyEventType.SessionError,
              properties: { sessionID, error: legacyError(event.data.error) },
            });
            await status(sessionID, SessionStatusKind.Idle);
            settled.push({ type: LegacyEventType.SessionIdle, properties: { sessionID } });
            break;
          case SessionEventType.ExecutionInterrupted:
            await emit({
              type: LegacyEventType.SessionError,
              properties: {
                sessionID,
                error: { name: ErrorName.Aborted, data: { message: event.data.reason } },
              },
            });
            await status(sessionID, SessionStatusKind.Idle);
            settled.push({ type: LegacyEventType.SessionIdle, properties: { sessionID } });
            break;
          case SessionEventType.ExecutionSucceeded:
            await status(sessionID, SessionStatusKind.Idle);
            settled.push({ type: LegacyEventType.SessionIdle, properties: { sessionID } });
            break;
          case SessionEventType.RetryScheduled: {
            const retry = {
              type: SessionStatusKind.Retry,
              attempt: event.data.attempt,
              message: event.data.error.message,
              next: event.data.at,
            };
            retries.set(sessionID, retry);
            await emit({
              type: LegacyEventType.SessionStatus,
              properties: { sessionID, status: retry },
            });
            break;
          }
          case SessionEventType.StepStarted:
            if (retries.clear(sessionID)) await status(sessionID, SessionStatusKind.Busy);
            break;
          case SessionEventType.ToolSuccess: {
            const todos = await recordTodos(context, sessionID, event.data, records, options);
            if (todos !== undefined)
              await emit({ type: LegacyEventType.TodoUpdated, properties: { sessionID, todos } });
            break;
          }
          case SessionEventType.CompactionEnded:
            settled.push({ type: LegacyEventType.SessionCompacted, properties: { sessionID } });
            break;
          case SessionEventType.InboxDelivered:
          case SessionEventType.Synthetic:
          case SessionEventType.StepEnded:
          case SessionEventType.StepFailed:
          case SessionEventType.TextDelta:
          case SessionEventType.TextEnded:
          case SessionEventType.ReasoningDelta:
          case SessionEventType.ReasoningEnded:
          case SessionEventType.ToolCalled:
          case SessionEventType.ToolProgress:
          case SessionEventType.ToolFailed:
            break;
          default:
            assertNever(event);
        }
        const current = legacyMessages(session, records);
        const previous = messages.get(sessionID) ?? [];
        for (const message of current) {
          const old = previous.find((entry) => entry.info.id === message.info.id);
          if (JSON.stringify(old?.info) !== JSON.stringify(message.info))
            await emit({
              type: LegacyEventType.MessageUpdated,
              properties: { info: message.info },
            });
          for (const part of message.parts) {
            const prior = old?.parts.find((entry) => entry.id === part.id);
            if (JSON.stringify(prior) !== JSON.stringify(part))
              await emit({ type: LegacyEventType.MessagePartUpdated, properties: { part } });
          }
        }
        messages.set(sessionID, current);
        for (const legacy of settled) await emit(legacy);
      };
      loop = (async () => {
        try {
          await seeded;
          let next = await first;
          while (next.done !== true) {
            try {
              await handle(next.value);
            } catch (error) {
              if (stopped(error)) return;
              console.error("Client bridge skipped an event it could not deliver", {
                type: next.value.type,
                error,
              });
            }
            next = await iterator.next();
          }
        } catch (error) {
          if (stopped(error)) return;
          throw error;
        } finally {
          await iterator.return?.();
        }
      })();
      void loop.catch((error: unknown) => {
        console.error("Client bridge event subscription failed", error);
      });
      await seeded;
    },
    async dispose(): Promise<void> {
      disposed = true;
      controller.abort();
      await loop;
    },
  };
}
