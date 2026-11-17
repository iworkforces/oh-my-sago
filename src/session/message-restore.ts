import { isDeepStrictEqual } from "node:util";
import type { ContentPart, ToolResultPart } from "@opencode/ai";
import type { Part, ToolPart } from "@opencode-ai/sdk";
import { assertNever } from "../client/errors.js";
import { CompatibilityError, nativeArguments } from "../domains/value.js";

export type Backing = { readonly native: ContentPart; readonly before: Part; readonly result?: ToolResultPart };
export const unsupported = (feature: string): never => { throw new CompatibilityError(`request history ${feature}`); };

function editResult(original: ToolResultPart | undefined, part: ToolPart): ToolResultPart {
  const base = original ?? { type: "tool-result" as const, id: part.callID, name: part.tool };
  switch (part.state.status) {
    case "error": return { ...base, result: { type: "error", value: part.state.error } };
    case "completed": {
      const output = part.state.output;
      if (original?.result.type === "content") {
        const result = original.result;
        let inserted = false;
        const value = result.value.flatMap<(typeof result.value)[number]>((item) => {
          if (item.type === "file") return [item];
          if (inserted) return [];
          inserted = true;
          return [{ ...item, text: output }];
        });
        return { ...base, result: { type: "content", value: inserted ? value : [{ type: "text", text: output }, ...value] } };
      }
      return { ...base, result: { type: "text", value: output } };
    }
    case "pending":
    case "running": return unsupported("tool result changed to an unfinished state");
    default: return assertNever(part.state);
  }
}

export function restore(part: Part, backing: Backing | undefined, edits: Map<ContentPart, ContentPart>): ContentPart[] {
  if (backing !== undefined && isDeepStrictEqual(part, backing.before)) return [backing.native];
  switch (part.type) {
    case "text":
    case "reasoning": {
      const { text: value, ...rest } = part;
      const before = backing?.before;
      if (before !== undefined) {
        switch (before.type) {
          case "text":
          case "reasoning": {
            const { text: previous, ...other } = before;
            if (!isDeepStrictEqual(rest, other)) return unsupported(`${part.type} attributes`);
            void previous;
            break;
          }
          case "agent": case "compaction": case "file": case "patch": case "retry":
          case "snapshot": case "step-finish": case "step-start": case "subtask": case "tool":
            return unsupported(`part kind changed to ${part.type}`);
          default: return assertNever(before);
        }
      }
      const native = backing?.native;
      switch (native?.type) {
        case "text": case "reasoning": return [{ ...native, text: value }];
        case undefined: return [{ type: part.type, text: value }];
        case "compaction": case "effort": case "media": case "tool-call": case "tool-result":
          return unsupported(`part kind changed to ${part.type}`);
        default: return assertNever(native);
      }
    }
    case "tool": {
      const before = backing?.before;
      if (before !== undefined && before.type !== "tool") return unsupported("part kind changed to tool");
      if (before !== undefined) {
        const { state: oldState, ...oldPart } = before;
        const { state, ...current } = part;
        if (!isDeepStrictEqual(oldPart, current)) return unsupported("tool identity or metadata edits");
        if (state.status === "completed" && oldState.status === "completed" &&
          !isDeepStrictEqual(state.attachments, oldState.attachments)) return unsupported("tool attachments");
      }
      const native = backing?.native;
      switch (native?.type) {
        case "tool-call": {
          const input = isDeepStrictEqual(part.state.input, before?.state.input) ? native.input : nativeArguments(native.name, part.state.input);
          const call = isDeepStrictEqual(input, native.input) ? native : { ...native, input };
          const result = backing?.result;
          if (result !== undefined) {
            if (!isDeepStrictEqual(part.state, before?.state)) edits.set(result, editResult(result, part));
            return [call];
          }
          switch (part.state.status) {
            case "pending":
            case "running": return [call];
            case "completed":
            case "error": return [call, editResult(undefined, part)];
            default: return assertNever(part.state);
          }
        }
        case "tool-result":
          if (!isDeepStrictEqual(part.state.input, before?.state.input)) return unsupported("tool result input");
          return [editResult(native, part)];
        case undefined: {
          const call: ContentPart = { type: "tool-call", id: part.callID, name: part.tool, input: part.state.input };
          switch (part.state.status) {
            case "pending":
            case "running": return [call];
            case "completed":
            case "error": return [call, editResult(undefined, part)];
            default: return assertNever(part.state);
          }
        }
        case "text": case "reasoning": case "media": case "compaction": case "effort": return unsupported("part kind changed to tool");
        default: return assertNever(native);
      }
    }
    case "file": case "snapshot": case "patch": case "agent": case "subtask":
    case "retry": case "compaction": case "step-start": case "step-finish": return unsupported(`${part.type} insertion or edit`);
    default: return assertNever(part);
  }
}
