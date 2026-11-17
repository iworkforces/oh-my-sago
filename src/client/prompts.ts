import type { Plugin } from "@opencode/plugin";
import { BridgeError, assertNever, unsupported } from "./errors.js";
import { legacyMessages } from "./messages.js";
import { body, promptBody, summarizeBody } from "./requests.js";
import { type ClientSessionState, promptOverrides } from "./state.js";
import { nativeAction } from "../domains/permissions.js";
import { metadata } from "../domains/value.js";

export function promptRoutes(context: Plugin.Context, state: ClientSessionState) {
  return async (request: Request, sessionID: string, operation: string): Promise<Response> => {
    const options = { signal: request.signal };
    if (operation === "summarize") {
      const input = await body(request, summarizeBody);
      await context.session.switchModel(
        { sessionID, model: { providerID: input.providerID, id: input.modelID } },
        options,
      );
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const events = context.event
        .subscribe({
          types: [
            "session.compaction.ended",
            "session.compaction.failed",
            "session.execution.interrupted",
            "session.deleted",
          ],
          signal,
        })
        [Symbol.asyncIterator]();
      let pending = events.next();
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(async () => {
        controller.abort();
        try {
          await pending;
        } catch (error) {
          if (error !== signal.reason && !(error instanceof Error && error.name === "AbortError"))
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
            case "session.compaction.failed":
              if (event.data.inputID === admitted.id)
                throw new BridgeError(500, event.data.error.message);
              break;
            case "session.compaction.ended": {
              const records = await context.session.context({ sessionID }, options);
              if (
                records.some((record) => record.id === admitted.id && record.type === "compaction")
              ) {
                await context.session.wait({ sessionID }, options);
                return Response.json(true);
              }
              break;
            }
            case "session.execution.interrupted":
              throw new BridgeError(409, "Session compaction was interrupted");
            case "session.deleted":
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
    if (input.noReply === true && operation !== "prompt_async")
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
              effect: enabled ? ("allow" as const) : ("deny" as const),
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
        case "text":
          if (part.ignored !== true) texts.push(part.text);
          break;
        case "file":
          files.push({
            uri: part.url,
            ...(part.filename === undefined ? {} : { name: part.filename }),
          });
          break;
        case "agent":
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
    if (operation === "prompt_async") return new Response(null, { status: 204 });
    await context.session.wait({ sessionID }, options);
    const session = await context.session.get({ sessionID }, options);
    const records = await context.session.context({ sessionID }, options);
    const messages = legacyMessages(session, records);
    const userIndex = messages.findIndex((message) => message.info.id === admission.id);
    const assistant = messages
      .slice(userIndex + 1)
      .findLast((message) => message.info.role === "assistant");
    if (userIndex < 0 || assistant === undefined)
      throw new BridgeError(
        500,
        `Prompt ${admission.id} produced no assistant message (${session.outcome ?? "unknown"})`,
      );
    if (
      assistant.info.role === "assistant" &&
      assistant.info.error === undefined &&
      session.outcome !== "succeeded"
    ) {
      assistant.info.error = {
        name: session.outcome === "interrupted" ? "MessageAbortedError" : "UnknownError",
        data: { message: `Session ${session.outcome ?? "did not succeed"}` },
      };
    }
    return Response.json(assistant);
  };
}
