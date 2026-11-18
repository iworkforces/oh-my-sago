import type { Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { registerDomains } from "../../../src/domains/index.js";
import { ContentKind, MessageRole, PartKind, PermissionEffect } from "../../../src/enums.js";
import { answer, scriptedProvider } from "../scripted-provider.js";

const hooks: Hooks = {
  tool: {
    bridge_echo: tool({
      description: "Echo the supplied message after checking permission.",
      args: { message: tool.schema.string() },
      async execute(input, context) {
        await context.ask({
          permission: "bridge_echo",
          patterns: ["fixture"],
          always: [],
          metadata: {},
        });
        context.metadata({ title: "echo progress", metadata: { seen: true } });
        return { title: "echo result", output: input.message, metadata: { owner: "legacy" } };
      },
    }),
  },
  async "tool.execute.before"(event, output) {
    if (event.tool === "bridge_echo") {
      const args = z.object({ message: z.string() }).parse(output.args);
      output.args = { message: `${args.message} before` };
    }
  },
  async "tool.execute.after"(event, output) {
    if (event.tool === "bridge_echo") output.output += " after";
  },
  async "command.execute.before"(_event, output) {
    for (const part of output.parts) if (part.type === PartKind.Text) part.text += " command hook";
  },
};

let calls = 0;
const provider = scriptedProvider(async (request) => {
  if (request.prompt.some((message) => message.role === MessageRole.Tool)) return answer("done");
  if (
    request.prompt.some(
      (message) =>
        message.role === MessageRole.User &&
        message.content.some(
          (part) => part.type === ContentKind.Text && part.text.includes("Ask a question."),
        ),
    )
  )
    return {
      ...answer(""),
      content: [
        {
          type: ContentKind.ToolCall,
          toolCallId: "question-1",
          toolName: "question",
          input: JSON.stringify({
            questions: [
              {
                question: "Continue?",
                header: "Continue",
                options: [{ label: "Yes", description: "Keep going" }],
              },
            ],
          }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    };
  calls += 1;
  return {
    ...answer(""),
    content: [
      {
        type: ContentKind.ToolCall,
        toolCallId: `echo-${calls}`,
        toolName: "bridge_echo",
        input: JSON.stringify({ message: "hello" }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
  };
});

// The CLI's plugin loader supplies @opencode/plugin and Effect runtime instances.
export default Plugin.define({
  id: "domain-fixture",
  async setup(context) {
    await using scope = new AsyncDisposableStack();
    const providerCleanup = await provider.setup(context);
    if (providerCleanup) scope.defer(providerCleanup);
    const dispose = await registerDomains(context, hooks, {
      agent: {
        "bridge-fixture": {
          prompt: "Fixture instructions",
          model: "omsago-test/scripted",
          permission: { edit: PermissionEffect.Deny },
        },
      },
      command: { "bridge-command": { template: "Argument: $ARGUMENTS" } },
    });
    scope.defer(dispose);
    scope.defer(
      (
        await context.command.transform((editor) => {
          editor.add({
            name: "fixture-wait",
            async execute(event) {
              await context.session.wait(
                { sessionID: event.sessionID },
                { signal: AbortSignal.timeout(10_000) },
              );
            },
          });
          editor.add({
            name: "fixture-dispose",
            async execute() {
              await dispose();
            },
          });
        })
      ).dispose,
    );
    const owned = scope.move();
    return () => owned.disposeAsync();
  },
});
