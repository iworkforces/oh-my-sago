import assert from "node:assert/strict";
import { APICallError } from "@ai-sdk/provider";
import { answer, type Script } from "../scripted-provider.js";

const childStarted = Promise.withResolvers<void>();

export const delegationScript: Script = async (request) => {
  const text = request.prompt.flatMap((message) => message.role === "user"
    ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n");
  if (text.includes("OMSG_CHILD_FAILURE")) {
    throw new APICallError({ message: "delegated model failure", url: "https://omsg-test.invalid/model", requestBodyValues: {}, statusCode: 400, isRetryable: false });
  }
  if (text.includes("OMSG_CHILD_CANCEL")) {
    const blocked = new Promise<never>((_resolve, reject) => {
      request.abortSignal?.addEventListener("abort", () => reject(request.abortSignal?.reason), { once: true });
    });
    childStarted.resolve();
    return blocked;
  }
  if (text.includes("OMSG_CHILD_OK")) return answer("child complete");
  const mode = ["OMSG_SYNC", "OMSG_BACKGROUND", "OMSG_FAILURE", "OMSG_CANCEL"].find((name) => text.includes(name));
  assert.ok(mode, text);
  const results = request.prompt.flatMap((message) => message.role === "tool" ? message.content : [])
    .filter((part) => part.type === "tool-result");
  const call = (name: string, input: Record<string, unknown>) => ({
    ...answer(""), content: [{ type: "tool-call" as const, toolCallId: `${mode}:${name}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  });
  if (results.length === 0) return call("task", {
    description: "Verify delegated execution", prompt: mode === "OMSG_FAILURE" ? "OMSG_CHILD_FAILURE"
      : mode === "OMSG_CANCEL" ? "OMSG_CHILD_CANCEL" : "OMSG_CHILD_OK",
    subagent_type: "explore", run_in_background: mode !== "OMSG_SYNC", load_skills: [],
  });
  if (mode === "OMSG_SYNC" || results.some((part) => part.toolName === "background_output" || part.toolName === "background_cancel")) return answer("omsg ready");
  const id = JSON.stringify(results).match(/bg_[a-zA-Z0-9]+/)?.[0];
  assert.ok(id, JSON.stringify(results));
  if (mode === "OMSG_CANCEL") {
    await childStarted.promise;
    return call("background_cancel", { taskId: id });
  }
  return call("background_output", { task_id: id, block: true });
};
