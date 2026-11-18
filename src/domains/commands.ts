import type { Hooks } from "@opencode-ai/plugin";
import type { Config, Part } from "@opencode-ai/sdk";
import { Model, type Plugin } from "@opencode/plugin";
import { CompatibilityError } from "./value.js";
import { promptInput } from "./prompt.js";
import { PartKind } from "../enums.js";

export async function registerCommands(context: Plugin.Context, hooks: Hooks, config: Config) {
  return context.command.transform((editor) => {
    for (const [name, definition] of Object.entries(config.command ?? {})) {
      editor.add({
        name,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        async execute(event) {
          if (definition.subtask) throw new CompatibilityError(`command ${name}: subtask`);
          if (/!`|@\{/.test(definition.template))
            throw new CompatibilityError(`command ${name}: shell or file expansion`);
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
          await hooks["command.execute.before"]?.(
            { command: name, sessionID: event.sessionID, arguments: argumentsText },
            output,
          );
          const text = output.parts
            .map((part) => {
              if (part.type !== PartKind.Text)
                throw new CompatibilityError(`command ${name}: ${part.type} part`);
              return part.text;
            })
            .join("\n");
          if (definition.agent)
            await context.session.switchAgent({
              sessionID: event.sessionID,
              agent: definition.agent,
            });
          if (definition.model) {
            const model = Model.Ref.parse(definition.model);
            await context.session.switchModel({
              sessionID: event.sessionID,
              model: {
                id: model.id,
                providerID: model.providerID,
                ...(model.variant === undefined ? {} : { variant: model.variant }),
              },
            });
          }
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
