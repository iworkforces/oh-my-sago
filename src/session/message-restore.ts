import { isDeepStrictEqual } from "node:util";
import type { ContentPart, ToolCallPart, ToolResultPart } from "@opencode/ai";
import type { Part, ToolPart } from "@opencode-ai/sdk";
import { assertNever } from "../client/errors.js";
import { CompatibilityError, nativeArguments, nativeName } from "../domains/value.js";
import {
  ContentKind,
  PartKind,
  ToolContentKind,
  ToolResultKind,
  ToolStateStatus,
} from "../enums.js";

export type Backing = {
  readonly native: ContentPart;
  readonly before: Part;
  readonly result?: ToolResultPart;
};
export const unsupported = (feature: string): never => {
  throw new CompatibilityError(`request history ${feature}`);
};

type ResultBase = Omit<ToolResultPart, "result"> & { readonly result?: ToolResultPart["result"] };

/** The identity of a result answering `call`, before it has a value. */
export const answering = (call: ToolCallPart): ResultBase => ({
  type: ContentKind.ToolResult,
  id: call.id,
  name: call.name,
  ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
});

function editResult(base: ResultBase, part: ToolPart): ToolResultPart {
  switch (part.state.status) {
    case ToolStateStatus.Error:
      return { ...base, result: { type: ToolResultKind.Error, value: part.state.error } };
    case ToolStateStatus.Completed: {
      const output = part.state.output;
      if (base.result?.type === ToolResultKind.Content) {
        const result = base.result;
        let inserted = false;
        const value = result.value.flatMap<(typeof result.value)[number]>((item) => {
          if (item.type === ToolContentKind.File) return [item];
          if (inserted) return [];
          inserted = true;
          return [{ ...item, text: output }];
        });
        return {
          ...base,
          result: {
            type: ToolResultKind.Content,
            value: inserted ? value : [{ type: ToolContentKind.Text, text: output }, ...value],
          },
        };
      }
      return { ...base, result: { type: ToolResultKind.Text, value: output } };
    }
    case ToolStateStatus.Pending:
    case ToolStateStatus.Running:
      return unsupported("tool result changed to an unfinished state");
    default:
      return assertNever(part.state);
  }
}

function answered(call: ToolCallPart, part: ToolPart): ContentPart[] {
  switch (part.state.status) {
    case ToolStateStatus.Pending:
    case ToolStateStatus.Running:
      return [call];
    case ToolStateStatus.Completed:
    case ToolStateStatus.Error:
      return [call, editResult(answering(call), part)];
    default:
      return assertNever(part.state);
  }
}

/**
 * Converts a legacy part back to native content. `edits` collects replacements for native results
 * whose call part changed, keyed by the result that call was paired with; `answers` maps each
 * restored call to that paired result.
 */
export function restore(
  part: Part,
  backing: Backing | undefined,
  edits: Map<ToolResultPart, ToolResultPart>,
  answers: Map<ContentPart, ToolResultPart>,
): ContentPart[] {
  if (backing !== undefined && isDeepStrictEqual(part, backing.before)) return [backing.native];
  switch (part.type) {
    case PartKind.Text:
    case PartKind.Reasoning: {
      const { text: value, ...rest } = part;
      const before = backing?.before;
      if (before !== undefined) {
        switch (before.type) {
          case PartKind.Text:
          case PartKind.Reasoning: {
            const { text: previous, ...other } = before;
            if (!isDeepStrictEqual(rest, other)) return unsupported(`${part.type} attributes`);
            void previous;
            break;
          }
          case PartKind.Agent:
          case PartKind.Compaction:
          case PartKind.File:
          case PartKind.Patch:
          case PartKind.Retry:
          case PartKind.Snapshot:
          case PartKind.StepFinish:
          case PartKind.StepStart:
          case PartKind.Subtask:
          case PartKind.Tool:
            return unsupported(`part kind changed to ${part.type}`);
          default:
            return assertNever(before);
        }
      }
      const native = backing?.native;
      switch (native?.type) {
        case ContentKind.Text:
          return [{ ...native, text: value }];
        // The signature and encrypted payload only vouch for the original text.
        case ContentKind.Reasoning:
          return [{ type: ContentKind.Reasoning, text: value }];
        case undefined:
          return [{ type: part.type, text: value }];
        case ContentKind.Compaction:
        case ContentKind.Effort:
        case ContentKind.Media:
        case ContentKind.ToolCall:
        case ContentKind.ToolResult:
          return unsupported(`part kind changed to ${part.type}`);
        default:
          return assertNever(native);
      }
    }
    case PartKind.Tool: {
      const before = backing?.before;
      if (before !== undefined && before.type !== PartKind.Tool)
        return unsupported("part kind changed to tool");
      if (before !== undefined) {
        const { state: oldState, ...oldPart } = before;
        const { state, ...current } = part;
        if (!isDeepStrictEqual(oldPart, current))
          return unsupported("tool identity or metadata edits");
        if (
          state.status === ToolStateStatus.Completed &&
          oldState.status === ToolStateStatus.Completed &&
          !isDeepStrictEqual(state.attachments, oldState.attachments)
        )
          return unsupported("tool attachments");
      }
      const native = backing?.native;
      switch (native?.type) {
        case ContentKind.ToolCall: {
          const input = isDeepStrictEqual(part.state.input, before?.state.input)
            ? native.input
            : nativeArguments(native.name, part.state.input);
          const call = isDeepStrictEqual(input, native.input) ? native : { ...native, input };
          const result = backing?.result;
          if (result === undefined) return answered(call, part);
          answers.set(call, result);
          if (!isDeepStrictEqual(part.state, before?.state))
            edits.set(result, editResult(result, part));
          return [call];
        }
        case ContentKind.ToolResult:
          if (!isDeepStrictEqual(part.state.input, before?.state.input))
            return unsupported("tool result input");
          return [editResult(native, part)];
        case undefined: {
          // A hook may write either legacy or native tool names and argument keys.
          const name = nativeName(part.tool);
          return answered(
            {
              type: ContentKind.ToolCall,
              id: part.callID,
              name,
              input: nativeArguments(name, part.state.input),
            },
            part,
          );
        }
        case ContentKind.Text:
        case ContentKind.Reasoning:
        case ContentKind.Media:
        case ContentKind.Compaction:
        case ContentKind.Effort:
          return unsupported("part kind changed to tool");
        default:
          return assertNever(native);
      }
    }
    case PartKind.File:
    case PartKind.Snapshot:
    case PartKind.Patch:
    case PartKind.Agent:
    case PartKind.Subtask:
    case PartKind.Retry:
    case PartKind.Compaction:
    case PartKind.StepStart:
    case PartKind.StepFinish:
      return unsupported(`${part.type} insertion or edit`);
    default:
      return assertNever(part);
  }
}
