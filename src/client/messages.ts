import type { SessionInfo, SessionMessageInfo, SessionStructuredError } from "@opencode/client";
import type { AssistantMessage, Message, Part, SessionMessagesResponse } from "@opencode-ai/sdk";
import { assertNever } from "./errors.js";
import { legacyToolState } from "./tool-parts.js";

export function legacyError(error: SessionStructuredError): NonNullable<AssistantMessage["error"]> {
  if (
    error.type.toLowerCase().includes("interrupt") ||
    error.type.toLowerCase().includes("abort")
  ) {
    return { name: "MessageAbortedError", data: { message: error.message } };
  }
  return {
    name: "APIError",
    data: {
      message: error.message,
      isRetryable: error.retryAfterMs !== undefined,
      ...(error.status === undefined ? {} : { statusCode: error.status }),
      ...(error.response === undefined ? {} : { responseBody: error.response.body }),
    },
  };
}

export function legacyMessages(
  session: SessionInfo,
  records: readonly SessionMessageInfo[],
): SessionMessagesResponse {
  const result: SessionMessagesResponse = [];
  let parentID = "";
  let agent = session.agent ?? "";
  let model = session.model;
  for (const record of records) {
    const base = { id: record.id, sessionID: session.id, time: { created: record.time.created } };
    const partBase = { id: `${record.id}:text`, sessionID: session.id, messageID: record.id };
    switch (record.type) {
      case "agent-switched":
        agent = record.agent;
        break;
      case "model-switched":
        model = record.model;
        break;
      case "user":
      case "synthetic":
      case "system":
      case "skill": {
        const info: Message = {
          ...base,
          role: "user",
          agent,
          model: { providerID: model?.providerID ?? "", modelID: model?.id ?? "" },
        };
        const parts: Part[] = [
          {
            ...partBase,
            type: "text",
            text: record.text,
            ...(record.type === "user" ? {} : { synthetic: true }),
          },
        ];
        if (record.type === "user") {
          parts.push(
            ...(record.files ?? []).map((file, index): Part => ({
              ...partBase,
              id: `${record.id}:file:${index}`,
              type: "file",
              mime: file.mime,
              url:
                file.source.type === "uri"
                  ? file.source.uri
                  : `data:${file.mime};base64,${file.data}`,
              ...(file.name === undefined ? {} : { filename: file.name }),
            })),
          );
          parts.push(
            ...(record.agents ?? []).map((mention, index): Part => ({
              ...partBase,
              id: `${record.id}:agent:${index}`,
              type: "agent",
              name: mention.name,
            })),
          );
        }
        result.push({ info, parts });
        parentID = record.id;
        break;
      }
      case "assistant": {
        const info: AssistantMessage = {
          ...base,
          role: "assistant",
          parentID,
          time: { ...record.time },
          providerID: record.model.providerID,
          modelID: record.model.id,
          mode: record.agent,
          path: { cwd: session.location.directory, root: session.location.directory },
          cost: record.cost ?? 0,
          tokens: record.tokens ?? {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          ...(record.error === undefined ? {} : { error: legacyError(record.error) }),
          ...(record.finish === undefined ? {} : { finish: record.finish }),
        };
        const parts = record.content.map((content, index): Part => {
          const identity = { ...partBase, id: `${record.id}:${index}` };
          switch (content.type) {
            case "text":
              return { ...identity, type: "text", text: content.text };
            case "reasoning":
              return {
                ...identity,
                type: "reasoning",
                text: content.text,
                time: {
                  start: content.time?.created ?? record.time.created,
                  ...(content.time?.completed === undefined ? {} : { end: content.time.completed }),
                },
              };
            case "tool": {
              const state = legacyToolState(content);
              if (state.status === "completed" && state.attachments) {
                state.attachments = state.attachments.map((file) => ({
                  ...file,
                  sessionID: session.id,
                  messageID: record.id,
                }));
              }
              return {
                ...identity,
                id: `${record.id}:tool:${content.id}`,
                type: "tool",
                callID: content.id,
                tool: content.name,
                state,
              };
            }
            default:
              return assertNever(content);
          }
        });
        result.push({ info, parts });
        break;
      }
      case "idle": {
        const last = result.at(-1);
        if (record.outcome !== "succeeded" && last?.info.role !== "assistant") {
          result.push({
            info: {
              ...base,
              role: "assistant",
              parentID,
              mode: agent,
              modelID: model?.id ?? "",
              providerID: model?.providerID ?? "",
              time: { created: record.time.created, completed: record.time.created },
              path: { cwd: session.location.directory, root: session.location.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              error:
                record.error === undefined
                  ? {
                      name:
                        record.outcome === "interrupted" ? "MessageAbortedError" : "UnknownError",
                      data: { message: `Session ${record.outcome}` },
                    }
                  : legacyError(record.error),
            },
            parts: [],
          });
        }
        if (
          last?.info.role === "assistant" &&
          record.outcome !== "succeeded" &&
          last.info.error === undefined
        ) {
          last.info.error =
            record.error === undefined
              ? {
                  name: record.outcome === "interrupted" ? "MessageAbortedError" : "UnknownError",
                  data: { message: `Session ${record.outcome}` },
                }
              : legacyError(record.error);
        }
        break;
      }
      case "location-switched":
      case "shell":
      case "compaction":
        break;
      default:
        assertNever(record);
    }
  }
  return result;
}
