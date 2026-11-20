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
/** Defined natively and by the legacy config; the native definition registers first and stays. */
const nativeServer = "bridge-native";
/** Probe modes whose permission request reached the legacy `permission.ask` hook. */
const probed = new Set<string>();
const probeArgs = z.object({ mode: z.string() });

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
    bridge_probe: tool({
      description: "Report how a probe mode came through the bridge's hooks.",
      args: { mode: tool.schema.string() },
      async execute(input, context) {
        const cycle: Record<string, unknown> = { kept: "yes" };
        cycle["self"] = cycle;
        const unrepresentable = input.mode === "cyclic" ? { cycle, big: 1n } : {};
        await context.ask({
          permission: "bridge_probe",
          patterns: [input.mode],
          always: [],
          metadata: { ...unrepresentable, phase: "ask" },
        });
        context.metadata({
          title: "probe progress",
          metadata: { ...unrepresentable, phase: "progress" },
        });
        return {
          title: "probe result",
          output: `probe ${input.mode}${probed.has(input.mode) ? " asked" : ""}`,
          metadata: { ...unrepresentable, owner: "probe" },
        };
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
  async config(input) {
    input.tools = { fixture_hidden: false, fixture_shown: true };
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
    if (event.tool === "bridge_probe" && probeArgs.parse(event.args).mode === "throw-after") {
      output.output += " mutated";
      output.metadata = { mutated: true };
      throw new Error("fixture after hook failure");
    }
  },
  async "permission.ask"(input, output) {
    if (input.type !== "bridge_probe") return;
    const [mode = ""] = [input.pattern ?? []].flat();
    probed.add(mode);
    if (mode === "throw-permission") {
      output.status = PermissionEffect.Deny;
      throw new Error("fixture permission hook failure");
    }
    if (mode === "invalid-status") Object.assign(output, { status: "sometimes" });
  },
  async "shell.env"(_input, output) {
    output.env["OMSAGO_FIXTURE_ENV"] = "partial";
    throw new Error("fixture shell.env failure");
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

function probeMode(request: Parameters<Script>[0]): string | undefined {
  for (const message of request.prompt)
    if (message.role === MessageRole.User)
      for (const part of message.content) {
        const mode =
          part.type === ContentKind.Text ? /Probe ([\w-]+)\./.exec(part.text)?.[1] : undefined;
        if (mode !== undefined) return mode;
      }
  return undefined;
}

let calls = 0;
const provider = scriptedProvider(async (request) => {
  if (request.prompt.some((message) => message.role === MessageRole.Tool)) return answer("done");
  const mode = probeMode(request);
  if (mode !== undefined)
    return {
      ...answer(""),
      content: [
        {
          type: ContentKind.ToolCall,
          toolCallId: `probe-${mode}`,
          toolName: "bridge_probe",
          input: JSON.stringify({ mode }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    };
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
          editor.set(
            nativeServer,
            new Mcp.LocalConfig({ type: McpServerType.Local, command: ["false"], disabled: true }),
          );
        })
      ).dispose,
    );
    // The SDK types cannot express malformed legacy entries, so the config skips type checking.
    const config = z.custom<Config>().parse({
      // Invalid global rules deny what they name; a default naming a removed agent is skipped.
      permission: {
        bridge_valid: PermissionEffect.Allow,
        bridge_global: "sometimes",
        bridge_shape: 42,
        bridge_mixed: { "allowed/*": PermissionEffect.Allow, "odd/*": "maybe" },
      },
      default_agent: seededAgents.permission,
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
      command: {
        "bridge-command": { template: "Argument: $ARGUMENTS" },
        // Each switches to a valid agent first, which a rejected model must not leave behind.
        "bridge-unlisted-model": {
          template: "Unlisted: $ARGUMENTS",
          agent: "bridge-fixture",
          model: "omsago-test/missing",
        },
        "bridge-invalid-model": {
          template: "Invalid: $ARGUMENTS",
          agent: "bridge-fixture",
          model: "not-a-model",
        },
        "bridge-missing-agent": { template: "Missing: $ARGUMENTS", agent: "bridge-missing" },
      },
      mcp: {
        "bridge-valid": { type: McpServerType.Local, command: ["false"], enabled: false },
        [configuredServer]: { enabled: false, unexpected: true },
        [nativeServer]: { type: McpServerType.Local, command: ["false"], enabled: true },
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
