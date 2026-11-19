import assert from "node:assert/strict";
import { APICallError } from "@ai-sdk/provider";
import { ContentKind, MessageRole, NativeTool, TodoStatus } from "../../../src/enums.js";
import { aborted, answer, type Script, variantHeader } from "../scripted-provider.js";

export const clientVariants = ["low", "high"] as const;
export const fixtureTodos = [
  { content: "plan the refactor", status: TodoStatus.InProgress },
  { content: "ship the refactor", status: TodoStatus.Pending },
] as const;

export interface VariantRequest {
  readonly text: string;
  readonly variant: string | undefined;
  readonly system: boolean;
}

export interface ClientModel {
  readonly script: Script;
  /** Settles once the next `CLIENT_CANCEL` request is blocked waiting for its abort signal. */
  blocked(): Promise<void>;
  readonly variants: readonly VariantRequest[];
}

function toolCall(name: string, input: unknown): Awaited<ReturnType<Script>> {
  return {
    ...answer(""),
    content: [
      {
        type: ContentKind.ToolCall,
        toolCallId: `client-${name}`,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
  };
}

export function clientModel(): ClientModel {
  const waiting: PromiseWithResolvers<void>[] = [];
  const variants: VariantRequest[] = [];
  let retries = 0;
  const script: Script = async (request) => {
    const text = request.prompt
      .flatMap((message) =>
        message.role === MessageRole.User
          ? message.content.flatMap((part) => (part.type === ContentKind.Text ? [part.text] : []))
          : [],
      )
      .join("\n");
    if (
      request.prompt.some(
        (message) =>
          message.role === MessageRole.System &&
          message.content.includes("omsago_COMPACTION_CONTEXT"),
      )
    )
      return answer(
        text.includes("CLIENT_COMPACTION_FAILURE")
          ? "invalid summary"
          : "## Objective\n- fixture summary",
      );
    const answered = request.prompt.some((message) => message.role === MessageRole.Tool);
    if (text.includes("CLIENT_VARIANT"))
      variants.push({
        text,
        variant: request.headers?.[variantHeader],
        system: request.prompt.some(
          (message) =>
            message.role === MessageRole.System && message.content.includes("variant-system"),
        ),
      });
    if (text.includes("CLIENT_RETRY") && retries++ === 0) throw new ScriptFailure(true);
    if (text.includes("CLIENT_TODO") && !answered) {
      assert.ok(request.tools?.some((tool) => tool.name === NativeTool.TodoWrite) === true);
      return toolCall(NativeTool.TodoWrite, {
        todos: text.includes("CLIENT_TODO_INVALID")
          ? [{ content: "invalid", status: "unknown" }]
          : fixtureTodos,
      });
    }
    if (text.includes("CLIENT_FAILURE")) throw new ScriptFailure(false);
    if (text.includes("CLIENT_CANCEL")) {
      const signal = request.abortSignal;
      signal?.throwIfAborted();
      const blocked = aborted(signal);
      for (const waiter of waiting.splice(0)) waiter.resolve();
      await blocked;
    }
    if (text.includes("CLIENT_READ")) {
      assert.equal(request.maxOutputTokens, 99);
      assert.equal(request.temperature, 0.25);
      assert.ok(text.includes("chat hook") && text.includes("messages hook"));
      assert.ok(
        request.prompt.some(
          (message) =>
            message.role === MessageRole.System &&
            message.content.includes("fixture-system") &&
            message.content.includes("system hook"),
        ),
      );
      if (!answered) {
        const read = request.tools?.find(
          (tool) => tool.name === "read_file" || tool.name === "read",
        );
        assert.ok(read);
        return toolCall(read.name, { path: "client.txt" });
      }
    }
    return answer("client boundary reply");
  };
  return {
    script,
    blocked() {
      const waiter = Promise.withResolvers<void>();
      waiting.push(waiter);
      return waiter.promise;
    },
    variants,
  };
}

class ScriptFailure extends APICallError {
  constructor(retryable: boolean) {
    super({
      message: retryable ? "scripted capacity failure" : "scripted model failure",
      url: "https://omsago-test.invalid/model",
      requestBodyValues: {},
      statusCode: retryable ? 503 : 400,
      isRetryable: retryable,
    });
  }
}
