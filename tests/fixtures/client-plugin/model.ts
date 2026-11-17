import assert from "node:assert/strict";
import { APICallError } from "@ai-sdk/provider";
import { answer, type Script } from "../scripted-provider.js";

export function clientModel() {
  const started = Promise.withResolvers<void>();
  const script: Script = async (request) => {
    const text = request.prompt.flatMap((message) => message.role === "user" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n");
    if (request.prompt.some((message) => message.role === "system" && message.content.includes("OMSG_COMPACTION_CONTEXT"))) return answer(text.includes("CLIENT_COMPACTION_FAILURE") ? "invalid summary" : "## Objective\n- fixture summary");
    if (text.includes("CLIENT_FAILURE")) throw new ScriptFailure();
    if (text.includes("CLIENT_CANCEL")) {
      const signal = request.abortSignal;
      signal?.throwIfAborted();
      const blocked = new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      started.resolve();
      await blocked;
    }
    if (text.includes("CLIENT_READ")) {
      assert.equal(request.maxOutputTokens, 99);
      assert.equal(request.temperature, 0.25);
      assert.ok(text.includes("chat hook") && text.includes("messages hook"));
      assert.ok(request.prompt.some((message) => message.role === "system" && message.content.includes("fixture-system") && message.content.includes("system hook")));
      if (!request.prompt.some((message) => message.role === "tool")) {
        const read = request.tools?.find((tool) => tool.name === "read_file" || tool.name === "read");
        assert.ok(read);
        const input = { path: "client.txt" };
        return { ...answer(""), content: [{ type: "tool-call", toolCallId: "client-read", toolName: read.name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_calls" } };
      }
    }
    return answer("client boundary reply");
  };
  return { script, started: started.promise };
}

class ScriptFailure extends APICallError {
  constructor() { super({ message: "scripted model failure", url: "https://omsg-test.invalid/model", requestBodyValues: {}, statusCode: 400, isRetryable: false }); }
}
