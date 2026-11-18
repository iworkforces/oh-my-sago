import type { Plugin } from "@opencode/plugin";
import { BridgeError, assertNever, unsupported } from "./errors.js";
import { legacyMessages } from "./messages.js";
import {
  ErrorName,
  MessageRole,
  PartKind,
  PermissionEffect,
  RecordType,
  SessionEventType,
  SessionOperation,
  SessionOutcome,
} from "../enums.js";
import { body, promptBody, summarizeBody } from "./requests.js";
import { type ClientSessionState, promptOverrides } from "./state.js";
import { nativeAction } from "../domains/permissions.js";
import { metadata } from "../domains/value.js";

export function promptRoutes(context: Plugin.Context, state: ClientSessionState) {
  return async (request: Request, sessionID: string, operation: string): Promise<Response> => {
    const options = { signal: request.signal };
    if (operation === SessionOperation.Summarize) {
      const input = await body(request, summarizeBody);
      await context.session.switchModel(
        { sessionID, model: { providerID: input.providerID, id: input.modelID } },
        options,
      );
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const subscription = context.event.subscribe({
        types: [
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
          if (
            error !== signal.reason &&
            !(error instanceof Error && error.name === ErrorName.Abort)
          )
            throw error;
        }
        await events.return?.();
      });
      const admitted = await context.session.compact({ sessionID }, options);
      for (;;) {
        const next = await pending;
        if (next.done)
          throw new BridgeError(500, "Session compaction subscription ended before completion");
        const event = next.value;
        if (event.data.sessionID === sessionID) {
          switch (event.type) {
            case SessionEventType.CompactionFailed:
              if (event.data.inputID === admitted.id)
                throw new BridgeError(500, event.data.error.message);
              break;
            case SessionEventType.CompactionEnded: {
              const records = await context.session.context({ sessionID }, options);
              if (
                records.some(
                  (record) => record.id === admitted.id && record.type === RecordType.Compaction,
                )
              ) {
                await context.session.wait({ sessionID }, options);
                return Response.json(true);
              }
              break;
            }
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
    if (input.variant !== undefined && input.model === undefined)
      unsupported("prompt.variant without model");
    if (input.agent !== undefined)
      await context.session.switchAgent({ sessionID, agent: input.agent }, options);
    if (input.model !== undefined)
      await context.session.switchModel(
        {
          sessionID,
          model: {
            providerID: input.model.providerID,
            id: input.model.modelID,
            ...(input.variant === undefined ? {} : { variant: input.variant }),
          },
        },
        options,
      );
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
    state.set(sessionID, overrides);
    const admission = await context.session.prompt(
      {
        sessionID,
        text: texts.join("\n"),
        files,
        agents,
        ...(input.messageID === undefined ? {} : { id: input.messageID }),
        metadata: { "omsg.client": metadata(overrides) },
        resume: input.noReply !== true,
      },
      options,
    );
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
