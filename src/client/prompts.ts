import type { Plugin } from "@opencode/plugin";
import { BridgeError, assertNever, unsupported } from "./errors.js";
import { legacyMessages } from "./messages.js";
import {
  ErrorName,
  MessageRole,
  PartKind,
  PermissionEffect,
  SessionEventType,
  SessionOperation,
  SessionOutcome,
} from "../enums.js";
import { body, promptBody, summarizeBody } from "./requests.js";
import type { IdleHolds } from "./sessions.js";
import { abortedBy } from "./signal.js";
import { clientMetadata, promptOverrides } from "./state.js";
import { nativeAction } from "../domains/permissions.js";
import { metadata } from "../domains/value.js";
import { applySwitch, resolveSwitch } from "../session/model.js";

export function promptRoutes(context: Plugin.Context, holds: IdleHolds) {
  return async (request: Request, sessionID: string, operation: string): Promise<Response> => {
    const options = { signal: request.signal };
    if (operation === SessionOperation.Summarize) {
      const input = await body(request, summarizeBody);
      const switching = await resolveSwitch(
        context,
        sessionID,
        { model: { providerID: input.providerID, id: input.modelID } },
        options,
      );
      await applySwitch(context, sessionID, switching, options);
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const subscription = context.event.subscribe({
        types: [
          SessionEventType.CompactionStarted,
          SessionEventType.CompactionEnded,
          SessionEventType.CompactionFailed,
          SessionEventType.ExecutionInterrupted,
          SessionEventType.Deleted,
        ],
        signal,
      });
      const events = subscription[Symbol.asyncIterator]();
      let pending = events.next();
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(async () => {
        controller.abort();
        try {
          await pending;
        } catch (error) {
          if (!abortedBy(signal, error)) throw error;
        }
        await events.return?.();
      });
      const admitted = await context.session.compact({ sessionID }, options);
      // `ended` carries no input id, so it answers this request only after our `started`.
      let ours = false;
      for (;;) {
        const next = await pending;
        if (next.done === true)
          throw new BridgeError(500, "Session compaction subscription ended before completion");
        const event = next.value;
        if (event.data.sessionID === sessionID) {
          switch (event.type) {
            case SessionEventType.CompactionStarted:
              ours = event.data.inputID === admitted.id;
              break;
            case SessionEventType.CompactionFailed:
              if (event.data.inputID === admitted.id)
                throw new BridgeError(500, event.data.error.message);
              break;
            case SessionEventType.CompactionEnded:
              if (ours) {
                await context.session.wait({ sessionID }, options);
                return Response.json(true);
              }
              break;
            case SessionEventType.ExecutionInterrupted:
              throw new BridgeError(409, "Session compaction was interrupted");
            case SessionEventType.Deleted:
              throw new BridgeError(404, "Session was deleted during compaction");
            default:
              assertNever(event);
          }
        }
        pending = events.next();
      }
    }
    const input = await body(request, promptBody);
    const overrides = promptOverrides.parse(input);
    if (input.noReply === true && operation !== SessionOperation.PromptAsync)
      unsupported("synchronous prompt.noReply response");
    const switching = await resolveSwitch(
      context,
      sessionID,
      {
        agent: input.agent,
        model:
          input.model === undefined
            ? undefined
            : { providerID: input.model.providerID, id: input.model.modelID },
      },
      options,
    );
    await applySwitch(context, sessionID, switching, options);
    if (input.tools !== undefined) {
      const session = await context.session.get({ sessionID }, options);
      await context.session.update(
        {
          sessionID,
          permissions: [
            ...(session.permissions ?? []),
            ...Object.entries(input.tools).map(([tool, enabled]) => ({
              action: nativeAction(tool),
              resource: "*",
              effect: enabled ? PermissionEffect.Allow : PermissionEffect.Deny,
            })),
          ],
        },
        options,
      );
    }
    const files = [];
    const agents = [];
    const texts: string[] = [];
    for (const part of input.parts) {
      switch (part.type) {
        case PartKind.Text:
          if (part.ignored !== true) texts.push(part.text);
          break;
        case PartKind.File:
          files.push({
            uri: part.url,
            ...(part.filename === undefined ? {} : { name: part.filename }),
          });
          break;
        case PartKind.Agent:
          agents.push({
            name: part.name,
            ...(part.source === undefined
              ? {}
              : {
                  mention: {
                    start: part.source.start,
                    end: part.source.end,
                    text: part.source.value ?? part.name,
                  },
                }),
          });
          break;
        default:
          assertNever(part);
      }
    }
    const admission = await context.session.prompt(
      {
        sessionID,
        text: texts.join("\n"),
        files,
        agents,
        ...(input.messageID === undefined ? {} : { id: input.messageID }),
        metadata: { [clientMetadata]: metadata(overrides) },
        resume: input.noReply !== true,
      },
      options,
    );
    holds.prompted(sessionID);
    if (operation === SessionOperation.PromptAsync) return new Response(null, { status: 204 });
    await context.session.wait({ sessionID }, options);
    const session = await context.session.get({ sessionID }, options);
    const records = await context.session.context({ sessionID }, options);
    const messages = legacyMessages(session, records);
    const userIndex = messages.findIndex((message) => message.info.id === admission.id);
    const assistant = messages
      .slice(userIndex + 1)
      .findLast((message) => message.info.role === MessageRole.Assistant);
    if (userIndex < 0 || assistant === undefined)
      throw new BridgeError(
        500,
        `Prompt ${admission.id} produced no assistant message (${session.outcome ?? "unknown"})`,
      );
    if (
      assistant.info.role === MessageRole.Assistant &&
      assistant.info.error === undefined &&
      session.outcome !== SessionOutcome.Succeeded
    ) {
      assistant.info.error = {
        name:
          session.outcome === SessionOutcome.Interrupted ? ErrorName.Aborted : ErrorName.Unknown,
        data: { message: `Session ${session.outcome ?? "did not succeed"}` },
      };
    }
    return Response.json(assistant);
  };
}
