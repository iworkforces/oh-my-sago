import type { Hooks } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import {
  type Json,
  type JsonRecord,
  degradedMetadata,
  errorMessage,
  inputSchema,
  legacyArguments,
  legacyName,
  metadata,
  nativeArguments,
} from "./value.js";
import { nativeAction } from "./permissions.js";
import { ToolContentKind, ToolStateStatus } from "../enums.js";

type ToolArgs = NonNullable<Hooks["tool"]>[string]["args"];

function describedInput(args: ToolArgs) {
  const descriptionArgs = Object.fromEntries(
    Object.entries(args).map(([key, argument]) => {
      const original = z.instanceof(z.ZodType).parse(argument);
      const copy = z.clone(original, original.def);
      const meta = z.globalRegistry.get(original);
      if (meta !== undefined) z.globalRegistry.add(copy, meta);
      return [key, copy];
    }),
  );
  return z.toJSONSchema(z.object(descriptionArgs), { io: "input" });
}

export async function prepareTools(
  context: Plugin.Context,
  hooks: Hooks,
): Promise<readonly Info[]> {
  const tools: Info[] = [];
  for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
    const schema = z.object(definition.args);
    let described: ReturnType<typeof describedInput>;
    try {
      described = describedInput(definition.args);
    } catch (error) {
      // zod throws a plain Error, not a ZodError, for types JSON Schema cannot represent.
      console.warn("omsago: Skipping tool whose arguments have no JSON Schema", {
        tool: name,
        reason: errorMessage(error),
      });
      continue;
    }
    tools.push({
      name,
      description: definition.description,
      input: described,
      output: { type: "string" },
      options: { codemode: false },
      async execute(input: Json, call) {
        call.signal.throwIfAborted();
        const progress: Promise<void>[] = [];
        const args = schema.parse(input);
        const result = await definition.execute(args, {
          sessionID: call.sessionID,
          messageID: call.messageID,
          agent: call.agent,
          directory: context.location.directory,
          worktree: context.location.project.directory,
          abort: call.signal,
          metadata(update) {
            progress.push(
              call.progress(
                degradedMetadata({ ...update.metadata, title: update.title }, `${name} progress`),
              ),
            );
          },
          async ask(request) {
            await context.permission.assert({
              sessionID: call.sessionID,
              agent: call.agent,
              action: nativeAction(request.permission),
              resources: request.patterns,
              save: request.always,
              metadata: degradedMetadata(request.metadata, `${name} permission request`),
              source: { type: "tool", messageID: call.messageID, id: call.id },
            });
          },
        });
        await Promise.all(progress);
        const resultMetadata = name === "skill" ? metadata({ name: args["name"] }) : {};
        if (typeof result === "string")
          return { output: result, content: result, metadata: resultMetadata };
        return {
          output: result.output,
          content: [
            { type: ToolContentKind.Text, text: result.output },
            ...(result.attachments ?? []).map((file) => ({
              type: ToolContentKind.File,
              uri: file.url,
              mime: file.mime,
              ...(file.filename === undefined ? {} : { name: file.filename }),
            })),
          ],
          metadata: degradedMetadata(
            { ...resultMetadata, ...result.metadata, title: result.title },
            `${name} result`,
          ),
        };
      },
    });
  }
  const definitions = [...(await context.tool.list()), ...tools];
  const prepared: Info[] = [];
  for (const definition of definitions) {
    const id = "id" in definition && typeof definition.id === "string" ? definition.id : undefined;
    const native = id !== undefined;
    let schema: string;
    let output: { description: string; parameters: JsonRecord };
    try {
      const parameters = inputSchema(definition.input);
      schema = JSON.stringify(parameters);
      output = { description: definition.description, parameters };
      await hooks["tool.definition"]?.({ toolID: legacyName(id ?? definition.name) }, output);
    } catch (error) {
      console.warn("omsago: Leaving tool as registered after a failed definition", {
        tool: id ?? definition.name,
        reason: errorMessage(error),
      });
      // A custom tool exists only here, so it registers as defined without the failed reshaping.
      if (!native) prepared.push(definition);
      continue;
    }
    const reshaped = JSON.stringify(output.parameters) !== schema;
    // The Promise editor rewraps an updated tool's execute on the plugin runtime, which drops the
    // caller's context; native events such as `form.created` then lose the location the TUI needs.
    if (native && !reshaped && output.description === definition.description) continue;
    prepared.push({
      ...definition,
      description: output.description,
      input: native && !reshaped ? definition.input : output.parameters,
    });
  }
  return prepared;
}

export async function registerTools(
  context: Plugin.Context,
  hooks: Hooks,
  definitions: readonly Info[],
): Promise<() => Promise<void>> {
  await using scope = new AsyncDisposableStack();
  const transform = await context.tool.transform((editor) => {
    for (const definition of definitions) {
      if ("id" in definition && typeof definition.id === "string") {
        editor.update(definition.id, (tool) => {
          tool.description = definition.description;
          tool.input = definition.input;
        });
      } else editor.add(definition);
    }
  });
  scope.defer(transform.dispose);
  const before = await context.tool.hook("execute.before", async (event) => {
    const name = event.tool;
    const output = { args: legacyArguments(name, event.input) };
    await hooks["tool.execute.before"]?.(
      { tool: legacyName(name), sessionID: event.sessionID, callID: event.id },
      output,
    );
    event.input = nativeArguments(name, output.args);
  });
  scope.defer(before.dispose);
  // The tool already ran: a failing after-hook keeps its result instead of failing the call, and a
  // typed tool error would read as a declined call that interrupts the turn.
  const after = await context.tool.hook("execute.after", async (event) => {
    if (event.status === ToolStateStatus.Error) return;
    try {
      const content = event.result.content;
      const text =
        typeof content === "string"
          ? content
          : (content ?? [])
              .flatMap((part) => (part.type === ToolContentKind.Text ? [part.text] : []))
              .join("\n");
      const output = {
        title:
          typeof event.result.metadata?.["title"] === "string"
            ? event.result.metadata["title"]
            : "",
        output: text,
        metadata: structuredClone(event.result.metadata ?? {}),
      };
      await hooks["tool.execute.after"]?.(
        {
          tool: legacyName(event.tool),
          sessionID: event.sessionID,
          callID: event.id,
          args: legacyArguments(event.tool, event.input),
        },
        output,
      );
      const changedContent =
        output.output === text
          ? content
          : [
              { type: ToolContentKind.Text, text: output.output },
              ...(typeof content === "string"
                ? []
                : (content ?? []).filter((part) => part.type !== ToolContentKind.Text)),
            ];
      event.result = {
        ...event.result,
        ...(typeof event.result.output === "string" ? { output: output.output } : {}),
        ...(changedContent === undefined ? {} : { content: changedContent }),
        metadata: metadata({ ...output.metadata, title: output.title }),
      };
    } catch (error) {
      console.warn("omsago: Keeping the tool result after tool.execute.after failed", {
        tool: event.tool,
        reason: errorMessage(error),
      });
    }
  });
  scope.defer(after.dispose);
  const owned = scope.move();
  return () => owned.disposeAsync();
}
