import { Plugin } from "@opencode/plugin";
import omsg from "../../../src/index.js";
import { answer, scriptedProvider } from "../scripted-provider.js";

const provider = scriptedProvider(async (request) => {
  const input = request.prompt
    .flatMap((message) =>
      message.role === "user"
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    )
    .find((text) => text.startsWith("DISCOVERY_SKILL "));
  if (input === undefined || request.prompt.some((message) => message.role === "tool"))
    return answer("discovery complete");
  return {
    ...answer(""),
    content: [
      {
        type: "tool-call",
        toolCallId: "discovery-skill",
        toolName: "skill",
        input: JSON.stringify({ name: input.slice("DISCOVERY_SKILL ".length) }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
  };
});

export default Plugin.define({
  id: "discovery-fixture",
  async setup(context) {
    await using scope = new AsyncDisposableStack();
    const providerCleanup = await provider.setup(context);
    if (providerCleanup) scope.defer(providerCleanup);
    const cleanup = await omsg.setup(context);
    if (cleanup) scope.defer(cleanup);
    scope.defer(
      (
        await context.command.transform((editor) => {
          editor.add({
            name: "discovery-wait",
            async execute(event) {
              await context.session.wait(
                { sessionID: event.sessionID },
                { signal: AbortSignal.timeout(30_000) },
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
