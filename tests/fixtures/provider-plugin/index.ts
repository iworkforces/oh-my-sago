import { answer, scriptedProvider } from "../scripted-provider.js";
import { Plugin } from "@opencode/plugin";
import { delegationScript } from "./delegation.js";

const provider = scriptedProvider(async (request) => {
  if (request.prompt.some((message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text.includes("OMSG_GUARD")))) {
    if (request.prompt.some((message) => message.role === "tool")) return answer("guard checked");
    return { ...answer(""), content: [{ type: "tool-call", toolCallId: "guard-write", toolName: "write", input: JSON.stringify({ path: "guard.txt", content: "overwritten" }) }], finishReason: { unified: "tool-calls", raw: "tool_calls" } };
  }
  if (request.prompt.some((message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text.includes("OMSG_")))) return delegationScript(request);
  if (request.prompt.some((message) => message.role === "tool")) return answer("omsg ready");
  return { ...answer(""), content: [{ type: "tool-call", toolCallId: "omsg-skill", toolName: "skill", input: JSON.stringify({ name: "git-master" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" } };
});

export default Plugin.define({
  id: provider.id,
  async setup(context) {
    await using scope = new AsyncDisposableStack();
    const cleanup = await provider.setup(context);
    if (cleanup) scope.defer(cleanup);
    scope.defer((await context.command.transform((editor) => {
      editor.add({ name: "fixture-wait", async execute(event) {
        await context.session.wait({ sessionID: event.sessionID }, { signal: AbortSignal.timeout(60_000) });
      } });
    })).dispose);
    const owned = scope.move();
    return () => owned.disposeAsync();
  },
});
