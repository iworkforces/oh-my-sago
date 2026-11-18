import assert from "node:assert/strict";
import { APICallError } from "@ai-sdk/provider";
import { ContentKind, MessageRole } from "../../../src/enums.js";
import type { JsonRecord } from "../../../src/domains/value.js";
import { aborted, answer, type Script } from "../scripted-provider.js";

const childStarted = Promise.withResolvers<void>();

export const delegationScript: Script = async (request) => {
  const text = request.prompt
    .flatMap((message) =>
      message.role === MessageRole.User
        ? message.content.flatMap((part) => (part.type === ContentKind.Text ? [part.text] : []))
        : [],
    )
    .join("\n");
  if (text.includes("omsago_CHILD_FAILURE")) {
    throw new APICallError({
      message: "delegated model failure",
      url: "https://omsago-test.invalid/model",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
  }
  if (text.includes("omsago_CHILD_CANCEL")) {
    const blocked = aborted(request.abortSignal);
    childStarted.resolve();
    return blocked;
  }
  if (text.includes("omsago_CHILD_OK")) return answer("child complete");
  const mode = ["omsago_SYNC", "omsago_BACKGROUND", "omsago_FAILURE", "omsago_CANCEL"].find(
    (name) => text.includes(name),
  );
  assert.ok(mode !== undefined, text);
  const results = request.prompt
    .flatMap((message) => (message.role === MessageRole.Tool ? message.content : []))
    .filter((part) => part.type === ContentKind.ToolResult);
  const call = (name: string, input: JsonRecord) => ({
    ...answer(""),
    content: [
      {
        type: ContentKind.ToolCall,
        toolCallId: `${mode}:${name}`,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  });
  if (results.length === 0)
    return call("task", {
      description: "Verify delegated execution",
      prompt:
        mode === "omsago_FAILURE"
          ? "omsago_CHILD_FAILURE"
          : mode === "omsago_CANCEL"
            ? "omsago_CHILD_CANCEL"
            : "omsago_CHILD_OK",
      subagent_type: "explore",
      run_in_background: mode !== "omsago_SYNC",
      load_skills: [],
    });
  if (
    mode === "omsago_SYNC" ||
    results.some(
      (part) => part.toolName === "background_output" || part.toolName === "background_cancel",
    )
  )
    return answer("omsago ready");
  const id = JSON.stringify(results).match(/bg_[a-zA-Z0-9]+/)?.[0];
  assert.ok(id !== undefined, JSON.stringify(results));
  if (mode === "omsago_CANCEL") {
    await childStarted.promise;
    return call("background_cancel", { taskId: id });
  }
  return call("background_output", { task_id: id, block: true });
};
