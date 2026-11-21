import type { Hooks } from "@opencode-ai/plugin";
import type { Config, Part } from "@opencode-ai/sdk";
import { Model, type Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { CompatibilityError, errorMessage } from "./value.js";
import { promptInput } from "./prompt.js";
import { PartKind } from "../enums.js";
import { applySwitch, resolveSwitch } from "../session/model.js";
import { forSession } from "../client/toast-session.js";

/** Parses a command's `model` once; a bad reference fails that command's runs, not registration. */
function commandModel(name: string, model: string | undefined): Model.Ref | Error | undefined {
  if (model === undefined || model === "") return undefined;
  try {
    return Model.Ref.parse(model);
  } catch (error) {
    return new CompatibilityError(`command ${name}: model ${model} (${errorMessage(error)})`);
  }
}

export async function registerCommands(
  context: Plugin.Context,
  hooks: Hooks,
  config: Config,
): Promise<Registration> {
  return context.command.transform((editor) => {
    for (const [name, definition] of Object.entries(config.command ?? {})) {
      const model = commandModel(name, definition.model);
      editor.add({
        name,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        async execute(event) {
          if (definition.subtask === true) throw new CompatibilityError(`command ${name}: subtask`);
          if (/!`|@\{/.test(definition.template))
            throw new CompatibilityError(`command ${name}: shell or file expansion`);
          if (model instanceof Error) throw model;
          const switching = await resolveSwitch(context, event.sessionID, {
            agent: definition.agent === "" ? undefined : definition.agent,
            model,
          });
          const argumentsText = event.prompt.text;
          const argumentsList = argumentsText.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
          const template = definition.template.replace(
            /\$ARGUMENTS|\$(\d+)/g,
            (match, position: string | undefined) =>
              match === "$ARGUMENTS" ? argumentsText : (argumentsList[Number(position) - 1] ?? ""),
          );
          const id = crypto.randomUUID();
          const output: { parts: Part[] } = {
            parts: [
              {
                type: PartKind.Text,
                id,
                messageID: id,
                sessionID: event.sessionID,
                text: template,
              },
            ],
          };
          await forSession(event.sessionID, async () => {
            await hooks["command.execute.before"]?.(
              { command: name, sessionID: event.sessionID, arguments: argumentsText },
              output,
            );
          });
          const text = output.parts
            .map((part) => {
              if (part.type !== PartKind.Text)
                throw new CompatibilityError(`command ${name}: ${part.type} part`);
              return part.text;
            })
            .join("\n");
          await applySwitch(context, event.sessionID, switching);
          await context.session.prompt({
            sessionID: event.sessionID,
            ...promptInput(event.prompt),
            text,
            delivery: event.delivery,
          });
        },
      });
    }
  });
}
