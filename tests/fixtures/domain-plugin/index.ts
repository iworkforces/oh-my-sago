import type { Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import { Mcp, Plugin } from "@opencode/plugin";
import { z } from "zod";
import { registerDomains } from "../../../src/domains/index.js";
import {
  ContentKind,
  MessageRole,
  McpServerType,
  PartKind,
  PermissionEffect,
} from "../../../src/enums.js";
import { answer, scriptedProvider, type Script } from "../scripted-provider.js";

// A native agent definition that a broken legacy override must not leave behind or loosen.
const seededAgents = {
  control: "bridge-seeded-control",
  steps: "bridge-seeded-steps",
  permission: "bridge-seeded-permission",
  disabled: "bridge-seeded-disabled",
} as const;
const configuredServer = "bridge-configured";

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
    bridge_unrepresentable: tool({
      description: "Accept a Date, which JSON Schema cannot represent.",
      args: { when: tool.schema.date() },
      async execute() {
        return "unreachable";
      },
    }),
  },
  async "tool.definition"(event, output) {
    if (event.toolID === "question") {
      output.description = "reshaped before the hook failed";
      throw new Error("fixture definition hook failure");
    }
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

function asked(request: Parameters<Script>[0], text: string): boolean {
  return request.prompt.some(
    (message) =>
      message.role === MessageRole.User &&
      message.content.some((part) => part.type === ContentKind.Text && part.text.includes(text)),
  );
}

let calls = 0;
const provider = scriptedProvider(async (request) => {
  if (request.prompt.some((message) => message.role === MessageRole.Tool)) return answer("done");
  if (asked(request, "List the tools."))
    return answer(
      `TOOLS ${JSON.stringify(
        Object.fromEntries(
          (request.tools ?? []).map((item) => [
            item.name,
            item.type === "function" ? (item.description ?? "") : "",
          ]),
        ),
      )}`,
    );
  if (asked(request, "Ask a question."))
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
    scope.defer(
      (
        await context.agent.transform((editor) => {
          for (const id of Object.values(seededAgents))
            editor.update(id, (agent) => {
              agent.mode = "subagent";
              agent.system = "seeded";
              agent.permissions.push({
                action: "*",
                resource: "*",
                effect: PermissionEffect.Allow,
              });
            });
        })
      ).dispose,
    );
    scope.defer(
      (
        await context.mcp.transform((editor) => {
          editor.set(
            configuredServer,
            new Mcp.LocalConfig({ type: McpServerType.Local, command: ["false"] }),
          );
        })
      ).dispose,
    );
    // The SDK types cannot express malformed legacy entries, so the config skips type checking.
    const config = z.custom<Config>().parse({
      agent: {
        "bridge-fixture": {
          prompt: "Fixture instructions",
          model: "omsago-test/scripted",
          permission: { edit: PermissionEffect.Deny },
        },
        [seededAgents.steps]: { prompt: "Broken steps", steps: 0 },
        [seededAgents.permission]: {
          prompt: "Broken permission",
          permission: { edit: "sometimes" },
        },
        [seededAgents.disabled]: {
          disable: true,
          steps: 0,
          permission: { edit: "sometimes" },
        },
      },
      command: { "bridge-command": { template: "Argument: $ARGUMENTS" } },
      mcp: {
        "bridge-valid": { type: McpServerType.Local, command: ["false"], enabled: false },
        [configuredServer]: { enabled: false, unexpected: true },
        "bridge-extra-key": { enabled: true, unexpected: true },
        "bridge-unsupported": { type: "sse", url: "https://example.invalid/sse" },
        "bridge-no-definition": { enabled: true },
      },
    });
    const dispose = await registerDomains(context, hooks, config);
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
