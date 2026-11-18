import type { Hooks } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import {
  type Json,
  inputSchema,
  legacyArguments,
  legacyName,
  metadata,
  nativeArguments,
} from "./value.js";
import { nativeAction } from "./permissions.js";
import { ToolContentKind, ToolStateStatus } from "../enums.js";

export async function prepareTools(
  context: Plugin.Context,
  hooks: Hooks,
): Promise<readonly Info[]> {
  const tools: Info[] = [];
  for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
    const schema = z.object(definition.args);
    const descriptionArgs = Object.fromEntries(
      Object.entries(definition.args).map(([key, argument]) => {
        const original = z.instanceof(z.ZodType).parse(argument);
        const copy = z.clone(original, original.def);
        const meta = z.globalRegistry.get(original);
        if (meta !== undefined) z.globalRegistry.add(copy, meta);
        return [key, copy];
      }),
    );
    tools.push({
      name,
      description: definition.description,
      input: z.toJSONSchema(z.object(descriptionArgs), { io: "input" }),
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
            progress.push(call.progress(metadata({ ...update.metadata, title: update.title })));
          },
          async ask(request) {
            await context.permission.assert({
              sessionID: call.sessionID,
              agent: call.agent,
              action: nativeAction(request.permission),
              resources: request.patterns,
              save: request.always,
              metadata: metadata(request.metadata),
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
          metadata: metadata({ ...resultMetadata, ...result.metadata, title: result.title }),
        };
      },
    });
  }
  const definitions = [...(await context.tool.list()), ...tools];
  const prepared: Info[] = [];
  for (const definition of definitions) {
    const output = {
      description: definition.description,
      parameters: inputSchema(definition.input),
    };
    await hooks["tool.definition"]?.(
      {
        toolID: legacyName(
          "id" in definition && typeof definition.id === "string" ? definition.id : definition.name,
        ),
      },
      output,
    );
    prepared.push({ ...definition, description: output.description, input: output.parameters });
  }
  return prepared;
}

export async function registerTools(
  context: Plugin.Context,
  hooks: Hooks,
  definitions: readonly Info[],
): Promise<readonly (() => Promise<void>)[]> {
  const registrations: (() => Promise<void>)[] = [];
  try {
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
    registrations.push(transform.dispose);
    const before = await context.tool.hook("execute.before", async (event) => {
      const name = event.tool;
      const output = { args: legacyArguments(name, event.input) };
      await hooks["tool.execute.before"]?.(
        { tool: legacyName(name), sessionID: event.sessionID, callID: event.id },
        output,
      );
      event.input = nativeArguments(name, output.args);
    });
    registrations.push(before.dispose);
    const after = await context.tool.hook("execute.after", async (event) => {
      if (event.status === ToolStateStatus.Error) return;
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
        metadata: { ...event.result.metadata },
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
    });
    registrations.push(after.dispose);
    return registrations;
  } catch (error) {
    await Promise.all(registrations.reverse().map((dispose) => dispose()));
    throw error;
  }
}
