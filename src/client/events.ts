import type { Plugin } from "@opencode/plugin";
import type { SessionInfo } from "@opencode/client";
import type { Hooks } from "@opencode-ai/plugin";
import type { SessionMessagesResponse } from "@opencode-ai/sdk";
import { BridgeError, assertNever } from "./errors.js";
import { legacyError, legacyMessages } from "./messages.js";
import { legacySession, listSessions } from "./sessions.js";

const types = [
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.moved",
  "session.agent.selected",
  "session.model.selected",
  "session.metadata.updated",
  "session.permissions",
  "session.archived",
  "session.unarchived",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.delivered",
  "session.synthetic",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
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
        new Request("http://omsg.invalid/session", { signal }),
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
            if (event.type === "session.deleted") {
              const session = sessions.get(sessionID);
              if (session === undefined)
                throw new BridgeError(500, `Deleted session ${sessionID} has no observed snapshot`);
              await emit({ type: "session.deleted", properties: { info: legacySession(session) } });
              sessions.delete(sessionID);
              messages.delete(sessionID);
            } else {
              const options = { signal };
              const session = await context.session.get({ sessionID }, options);
              sessions.set(sessionID, session);
              switch (event.type) {
                case "session.created":
                  await emit({
                    type: "session.created",
                    properties: { info: legacySession(session) },
                  });
                  break;
                case "session.renamed":
                case "session.moved":
                case "session.agent.selected":
                case "session.model.selected":
                case "session.metadata.updated":
                case "session.permissions":
                case "session.archived":
                case "session.unarchived":
                  await emit({
                    type: "session.updated",
                    properties: { info: legacySession(session) },
                  });
                  break;
                case "session.execution.started":
                  await emit({
                    type: "session.status",
                    properties: { sessionID, status: { type: "busy" } },
                  });
                  break;
                case "session.execution.failed":
                  await emit({
                    type: "session.error",
                    properties: { sessionID, error: legacyError(event.data.error) },
                  });
                  await emit({
                    type: "session.status",
                    properties: { sessionID, status: { type: "idle" } },
                  });
                  break;
                case "session.execution.interrupted":
                  await emit({
                    type: "session.error",
                    properties: {
                      sessionID,
                      error: { name: "MessageAbortedError", data: { message: event.data.reason } },
                    },
                  });
                  await emit({
                    type: "session.status",
                    properties: { sessionID, status: { type: "idle" } },
                  });
                  break;
                case "session.execution.succeeded":
                  await emit({
                    type: "session.status",
                    properties: { sessionID, status: { type: "idle" } },
                  });
                  await emit({ type: "session.idle", properties: { sessionID } });
                  break;
                case "session.inbox.delivered":
                case "session.synthetic":
                case "session.step.started":
                case "session.step.ended":
                case "session.step.failed":
                case "session.text.delta":
                case "session.text.ended":
                case "session.reasoning.delta":
                case "session.reasoning.ended":
                case "session.tool.called":
                case "session.tool.progress":
                case "session.tool.success":
                case "session.tool.failed":
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
                  await emit({ type: "message.updated", properties: { info: message.info } });
                for (const part of message.parts) {
                  const prior = old?.parts.find((entry) => entry.id === part.id);
                  if (JSON.stringify(prior) !== JSON.stringify(part))
                    await emit({ type: "message.part.updated", properties: { part } });
                }
              }
              messages.set(sessionID, current);
            }
            next = await iterator.next();
          }
        } catch (error) {
          if (
            signal.aborted &&
            (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
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
