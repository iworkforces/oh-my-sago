import type { SessionInfo, SessionMessageInfo, SessionStructuredError } from "@opencode/client";
import type { AssistantMessage, Message, Part, SessionMessagesResponse } from "@opencode-ai/sdk";
import {
  AssistantContentKind,
  ErrorName,
  MessageRole,
  PartKind,
  PromptFileSourceKind,
  RecordType,
  SessionOutcome,
  ToolStateStatus,
} from "../enums.js";
import { assertNever } from "./errors.js";
import { legacyToolState } from "./tool-parts.js";

export function legacyError(error: SessionStructuredError): NonNullable<AssistantMessage["error"]> {
  if (
    error.type.toLowerCase().includes("interrupt") ||
    error.type.toLowerCase().includes("abort")
  ) {
    return { name: ErrorName.Aborted, data: { message: error.message } };
  }
  return {
    name: ErrorName.Api,
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
      case RecordType.AgentSwitched:
        agent = record.agent;
        break;
      case RecordType.ModelSwitched:
        model = record.model;
        break;
      case RecordType.User:
      case RecordType.Synthetic:
      case RecordType.System:
      case RecordType.Skill: {
        const info: Message = {
          ...base,
          role: MessageRole.User,
          agent,
          model: { providerID: model?.providerID ?? "", modelID: model?.id ?? "" },
        };
        const parts: Part[] = [
          {
            ...partBase,
            type: PartKind.Text,
            text: record.text,
            ...(record.type === RecordType.User ? {} : { synthetic: true }),
          },
        ];
        if (record.type === RecordType.User) {
          parts.push(
            ...(record.files ?? []).map((file, index): Part => ({
              ...partBase,
              id: `${record.id}:file:${index}`,
              type: PartKind.File,
              mime: file.mime,
              url:
                file.source.type === PromptFileSourceKind.Uri
                  ? file.source.uri
                  : `data:${file.mime};base64,${file.data}`,
              ...(file.name === undefined ? {} : { filename: file.name }),
            })),
          );
          parts.push(
            ...(record.agents ?? []).map((mention, index): Part => ({
              ...partBase,
              id: `${record.id}:agent:${index}`,
              type: PartKind.Agent,
              name: mention.name,
            })),
          );
        }
        result.push({ info, parts });
        parentID = record.id;
        break;
      }
      case RecordType.Assistant: {
        const info: AssistantMessage = {
          ...base,
          role: MessageRole.Assistant,
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
            case AssistantContentKind.Text:
              return { ...identity, type: PartKind.Text, text: content.text };
            case AssistantContentKind.Reasoning:
              return {
                ...identity,
                type: PartKind.Reasoning,
                text: content.text,
                time: {
                  start: content.time?.created ?? record.time.created,
                  ...(content.time?.completed === undefined ? {} : { end: content.time.completed }),
                },
              };
            case AssistantContentKind.Tool: {
              const state = legacyToolState(content);
              if (state.status === ToolStateStatus.Completed && state.attachments) {
                state.attachments = state.attachments.map((file) => ({
                  ...file,
                  sessionID: session.id,
                  messageID: record.id,
                }));
              }
              return {
                ...identity,
                id: `${record.id}:tool:${content.id}`,
                type: PartKind.Tool,
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
      case RecordType.Idle: {
        const last = result.at(-1);
        if (
          record.outcome !== SessionOutcome.Succeeded &&
          last?.info.role !== MessageRole.Assistant
        ) {
          result.push({
            info: {
              ...base,
              role: MessageRole.Assistant,
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
                        record.outcome === SessionOutcome.Interrupted
                          ? ErrorName.Aborted
                          : ErrorName.Unknown,
                      data: { message: `Session ${record.outcome}` },
                    }
                  : legacyError(record.error),
            },
            parts: [],
          });
        }
        if (
          last?.info.role === MessageRole.Assistant &&
          record.outcome !== SessionOutcome.Succeeded &&
          last.info.error === undefined
        ) {
          last.info.error =
            record.error === undefined
              ? {
                  name:
                    record.outcome === SessionOutcome.Interrupted
                      ? ErrorName.Aborted
                      : ErrorName.Unknown,
                  data: { message: `Session ${record.outcome}` },
                }
              : legacyError(record.error);
        }
        break;
      }
      case RecordType.LocationSwitched:
      case RecordType.Shell:
      case RecordType.Compaction:
        break;
      default:
        assertNever(record);
    }
  }
  return result;
}
