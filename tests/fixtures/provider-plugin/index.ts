import { ContentKind, MessageRole } from "../../../src/enums.js";
import { type Script, answer, scriptedProvider } from "../scripted-provider.js";
import { Plugin } from "@opencode/plugin";
import { delegationScript } from "./delegation.js";

function prompted(request: Parameters<Script>[0], text: string): boolean {
  return request.prompt.some(
    (message) =>
      message.role === MessageRole.User &&
      message.content.some((part) => part.type === ContentKind.Text && part.text.includes(text)),
  );
}

const provider = scriptedProvider(async (request) => {
  if (prompted(request, "omsago_GUARD")) {
    if (request.prompt.some((message) => message.role === MessageRole.Tool))
      return answer("guard checked");
    return {
      ...answer(""),
      content: [
        {
          type: ContentKind.ToolCall,
          toolCallId: "guard-write",
          toolName: "write",
          input: JSON.stringify({ path: "guard.txt", content: "overwritten" }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    };
  }
  if (prompted(request, "omsago_")) return delegationScript(request);
  if (prompted(request, "List the sessions.")) {
    if (
      request.prompt.some(
        (message) =>
          message.role === MessageRole.Tool &&
          message.content.some(
            (part) => part.type === ContentKind.ToolResult && part.toolName === "session_list",
          ),
      )
    )
      return answer("sessions listed");
    return {
      ...answer(""),
      content: [
        {
          type: ContentKind.ToolCall,
          toolCallId: "omsago-sessions",
          toolName: "session_list",
          input: "{}",
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    };
  }
  if (request.prompt.some((message) => message.role === MessageRole.Tool))
    return answer("omsago ready");
  return {
    ...answer(""),
    content: [
      {
        type: ContentKind.ToolCall,
        toolCallId: "omsago-skill",
        toolName: "skill",
        input: JSON.stringify({ name: "git-master" }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
  };
});

export default Plugin.define({
  id: provider.id,
  async setup(context) {
    await using scope = new AsyncDisposableStack();
    const cleanup = await provider.setup(context);
    if (cleanup) scope.defer(cleanup);
    scope.defer(
      (
        await context.command.transform((editor) => {
          editor.add({
            name: "fixture-wait",
            async execute(event) {
              await context.session.wait(
                { sessionID: event.sessionID },
                { signal: AbortSignal.timeout(60_000) },
              );
            },
          });
        })
      ).dispose,
    );
    const owned = scope.move();
    return () => owned.disposeAsync();
  },
});
