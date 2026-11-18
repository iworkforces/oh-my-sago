import type { Plugin } from "@opencode/plugin";
import type { SessionInfo } from "@opencode/client";
import type { Hooks } from "@opencode-ai/plugin";
import type { SessionMessagesResponse } from "@opencode-ai/sdk";
import { ErrorName, LegacyEventType, SessionEventType, SessionStatusKind } from "../enums.js";
import { BridgeError, assertNever } from "./errors.js";
import { legacyError, legacyMessages } from "./messages.js";
import { legacySession, listSessions } from "./sessions.js";

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
] as const;

export function clientEvents(context: Plugin.Context) {
  const controller = new AbortController();
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, SessionMessagesResponse>();
  let loop: Promise<void> | undefined;
  let disposed = false;
  return {
    async start(hooks: Hooks): Promise<void> {
      if (disposed) throw new BridgeError(409, "The client bridge is disposed");
      if (loop !== undefined)
        throw new BridgeError(409, "The client bridge event subscription already started");
      const signal = controller.signal;
      const iterator = context.event.subscribe({ types, signal })[Symbol.asyncIterator]();
      const first = iterator.next();
      const seeded = listSessions(
        context,
        new Request("http://omsago.invalid/session", { signal }),
      ).then((records) => {
        for (const session of records) sessions.set(session.id, session);
      });
      const emit = async (event: Parameters<NonNullable<Hooks["event"]>>[0]["event"]) => {
        await hooks.event?.({ event });
      };
      loop = (async () => {
        try {
          await seeded;
          let next = await first;
          while (!next.done) {
            const event = next.value;
            const { sessionID } = event.data;
            if (event.type === SessionEventType.Deleted) {
              const session = sessions.get(sessionID);
              if (session === undefined)
                throw new BridgeError(500, `Deleted session ${sessionID} has no observed snapshot`);
              await emit({
                type: LegacyEventType.SessionDeleted,
                properties: { info: legacySession(session) },
              });
              sessions.delete(sessionID);
              messages.delete(sessionID);
            } else {
              const options = { signal };
              const session = await context.session.get({ sessionID }, options);
              sessions.set(sessionID, session);
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
                  await emit({
                    type: LegacyEventType.SessionStatus,
                    properties: { sessionID, status: { type: SessionStatusKind.Busy } },
                  });
                  break;
                case SessionEventType.ExecutionFailed:
                  await emit({
                    type: LegacyEventType.SessionError,
                    properties: { sessionID, error: legacyError(event.data.error) },
                  });
                  await emit({
                    type: LegacyEventType.SessionStatus,
                    properties: { sessionID, status: { type: SessionStatusKind.Idle } },
                  });
                  break;
                case SessionEventType.ExecutionInterrupted:
                  await emit({
                    type: LegacyEventType.SessionError,
                    properties: {
                      sessionID,
                      error: { name: ErrorName.Aborted, data: { message: event.data.reason } },
                    },
                  });
                  await emit({
                    type: LegacyEventType.SessionStatus,
                    properties: { sessionID, status: { type: SessionStatusKind.Idle } },
                  });
                  break;
                case SessionEventType.ExecutionSucceeded:
                  await emit({
                    type: LegacyEventType.SessionStatus,
                    properties: { sessionID, status: { type: SessionStatusKind.Idle } },
                  });
                  await emit({ type: LegacyEventType.SessionIdle, properties: { sessionID } });
                  break;
                case SessionEventType.InboxDelivered:
                case SessionEventType.Synthetic:
                case SessionEventType.StepStarted:
                case SessionEventType.StepEnded:
                case SessionEventType.StepFailed:
                case SessionEventType.TextDelta:
                case SessionEventType.TextEnded:
                case SessionEventType.ReasoningDelta:
                case SessionEventType.ReasoningEnded:
                case SessionEventType.ToolCalled:
                case SessionEventType.ToolProgress:
                case SessionEventType.ToolSuccess:
                case SessionEventType.ToolFailed:
                  break;
                default:
                  assertNever(event);
              }
              const current = legacyMessages(
                session,
                await context.session.context({ sessionID }, options),
              );
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
            }
            next = await iterator.next();
          }
        } catch (error) {
          if (
            signal.aborted &&
            (error === signal.reason || (error instanceof Error && error.name === ErrorName.Abort))
          )
            return;
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
