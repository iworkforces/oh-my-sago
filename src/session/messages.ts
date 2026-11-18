import type { ContentPart, ToolResultPart } from "@opencode/ai";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import type { Hooks } from "@opencode-ai/plugin";
import type { Message as LegacyMessage, Part, ToolPart } from "@opencode-ai/sdk";
import { z } from "zod";
import { assertNever } from "../client/errors.js";
import { legacyName } from "../domains/value.js";
import {
  ContentKind,
  MediaSourceKind,
  MessageRole,
  PartKind,
  ToolContentKind,
  ToolResultKind,
  ToolStateStatus,
} from "../enums.js";
import { type Backing, restore, unsupported } from "./message-restore.js";

type RequestMessage = SessionRequest["messages"][number];
type RecordMessage = { info: LegacyMessage; parts: Part[] };
const recordInput = z.record(z.string(), z.unknown());
const text = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));

function resultState(result: ToolResultPart, input: Record<string, unknown>): ToolPart["state"] {
  switch (result.result.type) {
    case ToolResultKind.Error:
      return {
        status: ToolStateStatus.Error,
        input,
        error: text(result.result.value),
        time: { start: 0, end: 0 },
      };
    case ToolResultKind.Text:
    case ToolResultKind.Json:
      return {
        status: ToolStateStatus.Completed,
        input,
        output: text(result.result.value),
        title: result.name,
        metadata: {},
        time: { start: 0, end: 0 },
      };
    case ToolResultKind.Content:
      return {
        status: ToolStateStatus.Completed,
        input,
        output: result.result.value
          .flatMap((item) => (item.type === ToolContentKind.Text ? [item.text] : []))
          .join("\n"),
        title: result.name,
        metadata: {},
        time: { start: 0, end: 0 },
        attachments: result.result.value.flatMap((item, index) =>
          item.type === ToolContentKind.File
            ? [
                {
                  type: PartKind.File,
                  id: `${result.id}:attachment:${index}`,
                  sessionID: "",
                  messageID: "",
                  mime: item.mime,
                  url: item.uri,
                  ...(item.name === undefined ? {} : { filename: item.name }),
                },
              ]
            : [],
        ),
      };
    default:
      return assertNever(result.result);
  }
}

function project(
  part: ContentPart,
  identity: Pick<Part, "id" | "sessionID" | "messageID">,
  result?: ToolResultPart,
): Part {
  switch (part.type) {
    case ContentKind.Text:
      return { ...identity, type: PartKind.Text, text: part.text };
    case ContentKind.Reasoning:
      return { ...identity, type: PartKind.Reasoning, text: part.text, time: { start: 0 } };
    case ContentKind.Media: {
      const source = part.media.source;
      let url: string;
      switch (source.type) {
        case MediaSourceKind.Url:
          url = source.url;
          break;
        case MediaSourceKind.Ref:
          url = source.id;
          break;
        case MediaSourceKind.Base64:
          url = `data:${source.mediaType};base64,${source.data}`;
          break;
        case MediaSourceKind.Bytes:
          url = `data:${source.mediaType};base64,${Buffer.from(source.data).toString("base64")}`;
          break;
        default:
          return assertNever(source);
      }
      return {
        ...identity,
        type: PartKind.File,
        mime: part.media.mediaType,
        url,
        ...(part.filename === undefined ? {} : { filename: part.filename }),
      };
    }
    case ContentKind.ToolCall: {
      const parsed = recordInput.safeParse(part.input);
      const input = parsed.success ? structuredClone(parsed.data) : {};
      return {
        ...identity,
        type: PartKind.Tool,
        callID: part.id,
        tool: legacyName(part.name),
        state:
          result === undefined
            ? { status: ToolStateStatus.Running, input, time: { start: 0 } }
            : resultState(result, input),
      };
    }
    case ContentKind.ToolResult:
      return {
        ...identity,
        type: PartKind.Tool,
        callID: part.id,
        tool: legacyName(part.name),
        state: resultState(part, {}),
      };
    // These controls have no editable legacy representation; their backing remains opaque.
    case ContentKind.Compaction:
    case ContentKind.Effort:
      return { ...identity, type: PartKind.Snapshot, snapshot: identity.id };
    default:
      return assertNever(part);
  }
}

function message(
  info: LegacyMessage,
  native: RequestMessage | undefined,
  content: ContentPart[],
): RequestMessage {
  const legacyRole =
    native?.role === MessageRole.System
      ? MessageRole.User
      : native?.role === MessageRole.Tool
        ? MessageRole.Assistant
        : native?.role;
  const role = legacyRole === info.role && native !== undefined ? native.role : info.role;
  if (
    native !== undefined &&
    role === native.role &&
    content.length === native.content.length &&
    content.every((part, index) => part === native.content[index])
  )
    return native;
  const base =
    native === undefined
      ? { id: info.id }
      : {
          ...("id" in native ? { id: native.id } : {}),
          ...("metadata" in native ? { metadata: native.metadata } : {}),
          ...("providerMetadata" in native ? { providerMetadata: native.providerMetadata } : {}),
        };
  switch (role) {
    case MessageRole.System: {
      const parts = content.filter(
        (part) => part.type === ContentKind.Text || part.type === ContentKind.Effort,
      );
      if (parts.length !== content.length) return unsupported("system message content");
      return { ...base, role, content: parts };
    }
    case MessageRole.User: {
      const parts = content.filter(
        (part) => part.type === ContentKind.Text || part.type === ContentKind.Media,
      );
      if (parts.length !== content.length) return unsupported("user message content");
      return { ...base, role, content: parts };
    }
    case MessageRole.Assistant: {
      const parts = content.filter((part) => part.type !== ContentKind.Effort);
      if (parts.length !== content.length) return unsupported("assistant message content");
      return { ...base, role, content: parts };
    }
    case MessageRole.Tool: {
      const parts = content.filter((part) => part.type === ContentKind.ToolResult);
      if (parts.length !== content.length) return unsupported("tool message content");
      return { ...base, role, content: parts };
    }
    default:
      return assertNever(role);
  }
}

export async function transformMessages(event: SessionRequest, hooks: Hooks): Promise<void> {
  const hook = hooks["experimental.chat.messages.transform"];
  if (hook === undefined) return;
  const messages = new Map<string, RequestMessage>();
  const parts = new Map<string, Backing>();
  const results = new Map<string, ToolResultPart>();
  for (const record of event.messages)
    for (const part of record.content) {
      if (part.type === ContentKind.ToolResult) results.set(part.id, part);
    }
  const output: { messages: RecordMessage[] } = {
    messages: event.messages.map((native, index) => {
      const id = native.id ?? `omsago:request:${index}`;
      messages.set(id, native);
      const base = { id, sessionID: event.sessionID, time: { created: 0 } };
      const info: LegacyMessage =
        native.role === MessageRole.User || native.role === MessageRole.System
          ? {
              ...base,
              role: MessageRole.User,
              agent: "",
              model: { providerID: event.model.providerID, modelID: event.model.id },
            }
          : {
              ...base,
              role: MessageRole.Assistant,
              parentID: "",
              modelID: event.model.id,
              providerID: event.model.providerID,
              mode: "",
              path: { cwd: "", root: "" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            };
      return {
        info,
        parts: native.content.map((part, partIndex) => {
          const result = part.type === ContentKind.ToolCall ? results.get(part.id) : undefined;
          const projected = project(
            part,
            { id: `omsago:request:${index}:${partIndex}`, sessionID: event.sessionID, messageID: id },
            result,
          );
          parts.set(projected.id, {
            native: part,
            before: structuredClone(projected),
            ...(result === undefined ? {} : { result }),
          });
          return projected;
        }),
      };
    }),
  };
  await hook({}, output);
  const edits = new Map<ContentPart, ContentPart>();
  const converted = output.messages.map((record) => ({
    record,
    content: record.parts.flatMap((part) => restore(part, parts.get(part.id), edits)),
  }));
  event.messages = converted.map(({ record, content }) =>
    message(
      record.info,
      messages.get(record.info.id),
      content.map((part) => edits.get(part) ?? part),
    ),
  );
}
