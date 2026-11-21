import type { ContentPart, ToolCallPart, ToolResultPart } from "@opencode/ai";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import type { Hooks } from "@opencode-ai/plugin";
import type { Message as LegacyMessage, Part, ToolPart } from "@opencode-ai/sdk";
import { assertNever } from "../client/errors.js";
import { type JsonRecord, jsonRecord, legacyName } from "../domains/value.js";
import {
  ContentKind,
  MediaSourceKind,
  MessageRole,
  PartKind,
  ToolContentKind,
  ToolResultKind,
  ToolStateStatus,
} from "../enums.js";
import { hideMarkers, showMarkers, storedMarkers } from "./markers.js";
import { type Backing, answering, restore, unsupported } from "./message-restore.js";

type RequestMessage = SessionRequest["messages"][number];
type RecordMessage = { info: LegacyMessage; parts: Part[] };
type ResultValue = Exclude<
  ToolResultPart["result"],
  { type: typeof ToolResultKind.Content }
>["value"];
const text = (value: ResultValue): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
// The error OpenCode's own history normalization sends for a call that has no result.
const missingResult = "Tool result missing";

function resultState(result: ToolResultPart, input: JsonRecord): ToolPart["state"] {
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
      const parsed = jsonRecord.safeParse(part.input);
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

/**
 * Pairs each tool call with the first later result of the same id that comes before the next
 * assistant message, so a call id reused by another turn never borrows that turn's result.
 */
function pairResults(messages: readonly RequestMessage[]): Map<ContentPart, ToolResultPart> {
  const pairs = new Map<ContentPart, ToolResultPart>();
  let open: ToolCallPart[] = [];
  for (const native of messages) {
    if (native.role === MessageRole.Assistant) open = [];
    for (const part of native.content) {
      if (part.type === ContentKind.ToolCall) open.push(part);
      if (part.type !== ContentKind.ToolResult) continue;
      const index = open.findIndex((call) => call.id === part.id);
      const call = open[index];
      if (call === undefined) continue;
      pairs.set(call, part);
      open.splice(index, 1);
    }
  }
  return pairs;
}

/** Copies a native message's identity and metadata field by field; schema classes cannot be spread. */
function nativeFields(native: RequestMessage) {
  return {
    ...("id" in native ? { id: native.id } : {}),
    ...("metadata" in native ? { metadata: native.metadata } : {}),
    ...("providerMetadata" in native ? { providerMetadata: native.providerMetadata } : {}),
  };
}

function message(
  info: LegacyMessage,
  native: RequestMessage | undefined,
  claimed: Set<RequestMessage>,
  content: ContentPart[],
): RequestMessage {
  const legacyRole =
    native?.role === MessageRole.System
      ? MessageRole.User
      : native?.role === MessageRole.Tool
        ? MessageRole.Assistant
        : native?.role;
  const role = legacyRole === info.role && native !== undefined ? native.role : info.role;
  // Only the first record that keeps a native message's role inherits its identity and metadata.
  const owned = native !== undefined && role === native.role && !claimed.has(native);
  if (owned) claimed.add(native);
  if (
    owned &&
    content.length === native.content.length &&
    content.every((part, index) => part === native.content[index])
  )
    return native;
  const base = owned ? nativeFields(native) : native === undefined ? { id: info.id } : {};
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

type Pending = { readonly call: ToolCallPart; answered: boolean; lifted?: ToolResultPart };

/**
 * Makes one turn (an assistant message and everything before the next one) a valid exchange: each
 * call the client answers gets exactly one result, in a tool message right after the assistant
 * message, and a result without an earlier unanswered call is dropped. A result restored inside
 * the assistant message moves to a tool message unless the provider executed it.
 */
function answerTurn(
  turn: readonly RequestMessage[],
  fallback: (call: ToolCallPart) => ToolResultPart,
): RequestMessage[] {
  const pending: Pending[] = [];
  const leading: RequestMessage[] = [];
  const moved: RequestMessage[] = [];
  const rest: RequestMessage[] = [];
  for (const native of turn) {
    switch (native.role) {
      case MessageRole.Assistant: {
        const content = native.content.filter((part) => {
          if (part.type === ContentKind.ToolCall && part.providerExecuted !== true)
            pending.push({ call: part, answered: false });
          if (part.type !== ContentKind.ToolResult || part.providerExecuted === true) return true;
          const entry = pending.find(
            (item) => !item.answered && item.lifted === undefined && item.call.id === part.id,
          );
          if (entry !== undefined) entry.lifted = part;
          return false;
        });
        leading.push(
          content.length === native.content.length
            ? native
            : { ...nativeFields(native), role: native.role, content },
        );
        break;
      }
      case MessageRole.Tool: {
        const content = native.content.filter((part) => {
          const entry = pending.find((item) => !item.answered && item.call.id === part.id);
          if (entry !== undefined) entry.answered = true;
          return entry !== undefined;
        });
        if (content.length === 0) break;
        const kept =
          content.length === native.content.length
            ? native
            : { ...nativeFields(native), role: native.role, content };
        if (rest.length === 0) leading.push(kept);
        else moved.push(kept);
        break;
      }
      case MessageRole.System:
      case MessageRole.User:
        rest.push(native);
        break;
      default:
        return assertNever(native);
    }
  }
  const answers = pending.flatMap(({ call, answered, lifted }) =>
    answered ? [] : [{ role: MessageRole.Tool, content: [lifted ?? fallback(call)] }],
  );
  return [...leading, ...moved, ...answers, ...rest];
}

function splitTurns(messages: readonly RequestMessage[]): RequestMessage[][] {
  const turns: RequestMessage[][] = [];
  let turn: RequestMessage[] = [];
  for (const native of messages) {
    if (native.role === MessageRole.Assistant) {
      turns.push(turn);
      turn = [];
    }
    turn.push(native);
  }
  turns.push(turn);
  return turns;
}

function answerCalls(
  messages: readonly RequestMessage[],
  fallback: (call: ToolCallPart) => ToolResultPart,
): RequestMessage[] {
  return splitTurns(messages).flatMap((entries) => answerTurn(entries, fallback));
}

const reminderBlock = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** OpenCode's report of a child's answer, without a note of work the child still runs. */
const childReport =
  /^<subagent sessionID="[^"]+" state="completed" description="([^\n]*)">\n([\s\S]*)\n<\/subagent>$/;
/** OmO titles a `look_at` child with this prefix, and OpenCode reports the title as its description. */
const lookAtTitle = "look_at: ";
const words = (value: string): string => value.replace(/\s+/g, " ").trim();

interface Report {
  readonly childID: string;
  readonly description: string;
  readonly answer: string;
}

function childAnswer(native: RequestMessage): Report | undefined {
  if (native.role !== MessageRole.User || native.metadata?.["source"] !== "subagent")
    return undefined;
  const childID = native.metadata["childID"];
  const [part, ...rest] = native.content;
  if (typeof childID !== "string" || part?.type !== ContentKind.Text || rest.length > 0)
    return undefined;
  const [, description, answer] = childReport.exec(part.text) ?? [];
  return description === undefined || answer === undefined || words(answer) === ""
    ? undefined
    : { childID, description, answer };
}

function resultText(part: ToolResultPart): string | undefined {
  switch (part.result.type) {
    case ToolResultKind.Text:
      return text(part.result.value);
    case ToolResultKind.Content:
      return part.result.value
        .flatMap((item) => (item.type === ToolContentKind.Text ? [item.text] : []))
        .join("\n");
    case ToolResultKind.Json:
    case ToolResultKind.Error:
      return undefined;
    default:
      return assertNever(part.result);
  }
}

/**
 * Whether a tool result already gave the model the reported answer: OmO's synchronous `task`
 * returns each of its lines whole with the child's session id, `look_at` returns it alone.
 * OpenCode joins the answer's text parts with blank lines, and OmO joins them, with reasoning
 * between, with line breaks.
 */
function returned(report: Report, results: readonly ToolResultPart[]): boolean {
  const answer = words(report.answer);
  const lines = report.answer.split("\n").map(words);
  return results.some((result) => {
    const output = resultText(result);
    if (output === undefined) return false;
    if (result.name === "look_at")
      return report.description.startsWith(lookAtTitle) && words(output) === answer;
    if (!output.includes(report.childID)) return false;
    const whole = new Set(output.split("\n").map(words));
    return lines.every((line) => line === "" || whole.has(line));
  });
}

function cleanTurn(
  turn: readonly RequestMessage[],
  shown: ReadonlySet<string>,
  earlier: readonly ToolResultPart[],
): {
  messages: RequestMessage[];
  kept: ReadonlySet<string>;
  results: readonly ToolResultPart[];
} {
  const kept = new Set<string>();
  const results: ToolResultPart[] = [];
  const messages = turn.flatMap((native): RequestMessage[] => {
    if (native.role === MessageRole.Tool) results.push(...native.content);
    if (native.role !== MessageRole.User) return [native];
    const report = childAnswer(native);
    if (report !== undefined && (returned(report, results) || returned(report, earlier))) return [];
    const fromOmO =
      storedMarkers(native.metadata).length > 0 ||
      native.content.some(
        (part) => part.type === ContentKind.Text && hideMarkers(part.text).markers.length > 0,
      );
    let changed = false;
    const content = native.content.flatMap((part): (typeof native.content)[number][] => {
      if (part.type !== ContentKind.Text) return [part];
      const { text: unmarked, markers } = hideMarkers(part.text);
      let removed = markers.length > 0;
      const cleaned = unmarked
        .replace(reminderBlock, (block) => {
          if (!kept.has(block) && !(fromOmO && shown.has(block))) {
            kept.add(block);
            return block;
          }
          removed = true;
          return "";
        })
        .trim();
      if (!removed) return [part];
      changed = true;
      return cleaned === "" ? [] : [{ ...part, text: cleaned }];
    });
    if (!changed) return [native];
    return content.length === 0 ? [] : [{ ...nativeFields(native), role: native.role, content }];
  });
  return { messages, kept, results };
}

const prompting = (native: RequestMessage): boolean => native.role !== MessageRole.Assistant;

/**
 * Shows the model OmO's internal prompts as written for it: without OmO's markers, and without a
 * `<system-reminder>` block the model was already shown. OmO records a background notice without a
 * reply while its parent looks busy, then sends the same notice to wake the parent; v2 holds the
 * first in the session inbox until that wake, so both reach the model side by side. OmO also sends a
 * notice again, merged with any newer one, when no assistant output shows up within seconds of the
 * first send, although the model may have read and answered it by then. So a block is dropped when
 * an earlier user message of its turn carries it, or when OmO repeats it from an earlier turn; a
 * user's own message keeps what it quotes. OpenCode reports a child's answer to its parent as the
 * child's turn ends, also when a tool of the parent already returned that answer, so that report is
 * dropped too. A message left empty is dropped, unless that leaves its turn with nothing to answer:
 * the repeat alone is then asking, and the turn keeps it.
 */
export function cleanInternalPrompts(messages: readonly RequestMessage[]): RequestMessage[] {
  const shown = new Set<string>();
  const results: ToolResultPart[] = [];
  return splitTurns(messages).flatMap((turn) => {
    let cleaned = cleanTurn(turn, shown, results);
    if (turn.some(prompting) && !cleaned.messages.some(prompting))
      cleaned = cleanTurn(turn, new Set(), []);
    for (const block of cleaned.kept) shown.add(block);
    for (const result of cleaned.results) results.push(result);
    return cleaned.messages;
  });
}

export async function transformMessages(event: SessionRequest, hooks: Hooks): Promise<void> {
  const hook = hooks["experimental.chat.messages.transform"];
  if (hook === undefined) return;
  const messages = new Map<string, RequestMessage>();
  const parts = new Map<string, Backing>();
  const answers = pairResults(event.messages);
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
      // OmO reads its markers back from the text a user prompt was stored without.
      const marked =
        native.role === MessageRole.User
          ? native.content.findLastIndex((part) => part.type === ContentKind.Text)
          : -1;
      return {
        info,
        parts: native.content.map((part, partIndex) => {
          const result = answers.get(part);
          const projected = project(
            part,
            {
              id: `omsago:request:${index}:${partIndex}`,
              sessionID: event.sessionID,
              messageID: id,
            },
            result,
          );
          if (partIndex === marked && projected.type === PartKind.Text)
            projected.text = showMarkers(projected.text, native.metadata);
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
  const edits = new Map<ToolResultPart, ToolResultPart>();
  const converted = output.messages.map((record) => ({
    record,
    content: record.parts.flatMap((part) => restore(part, parts.get(part.id), edits, answers)),
  }));
  const claimed = new Set<RequestMessage>();
  const restored = converted.map(({ record, content }) =>
    message(
      record.info,
      messages.get(record.info.id),
      claimed,
      content.map((part) =>
        part.type === ContentKind.ToolResult ? (edits.get(part) ?? part) : part,
      ),
    ),
  );
  event.messages = answerCalls(restored, (call) => {
    const answer = answers.get(call);
    if (answer !== undefined) return edits.get(answer) ?? answer;
    return { ...answering(call), result: { type: ToolResultKind.Error, value: missingResult } };
  });
}
