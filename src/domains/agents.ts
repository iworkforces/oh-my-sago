import type { Config } from "@opencode-ai/sdk";
import { Agent, Model, type Plugin } from "@opencode/plugin";
import { z } from "zod";
import { nativePermissions } from "./permissions.js";

const extras = z.object({
  hidden: z.boolean().optional(),
  variant: z.string().optional(),
  steps: z.number().int().positive().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export async function registerAgents(context: Plugin.Context, config: Config) {
  const definitions = Object.entries(config.agent ?? {}).flatMap(([name, definition]) =>
    definition === undefined ? [] : [{ name, definition, extra: extras.parse(definition) }],
  );
  const selection = z.object({ default_agent: z.string().optional() }).parse(config);
  return context.agent.transform((editor) => {
    for (const { name, definition, extra } of definitions) {
      if (definition.disable) {
        editor.remove(name);
        continue;
      }
      editor.update(name, (agent) => {
        agent.name = Agent.Name.make(name);
        if (definition.model) {
          agent.model = {
            ...Model.Ref.parse(definition.model),
            ...(extra.variant === undefined
              ? {}
              : { variant: Model.VariantID.make(extra.variant) }),
          };
        }
        if (definition.prompt !== undefined) agent.system = definition.prompt;
        if (definition.description !== undefined) agent.description = definition.description;
        if (definition.mode !== undefined) agent.mode = definition.mode;
        if (extra.hidden !== undefined) agent.hidden = extra.hidden;
        if (definition.color !== undefined) agent.color = definition.color;
        const steps = extra.steps ?? definition.maxSteps;
        if (steps !== undefined) agent.steps = steps;
        agent.request.body = {
          ...agent.request.body,
          ...extra.options,
          ...(definition.temperature === undefined ? {} : { temperature: definition.temperature }),
          ...(definition.top_p === undefined ? {} : { top_p: definition.top_p }),
        };
        agent.permissions.push(
          ...nativePermissions(config.permission),
          ...nativePermissions(
            Object.fromEntries(
              Object.entries(definition.tools ?? {}).map(([tool, enabled]) => [
                tool,
                enabled ? "allow" : "deny",
              ]),
            ),
          ),
          ...nativePermissions(definition.permission),
        );
      });
    }
    if (selection.default_agent !== undefined) editor.default(selection.default_agent);
  });
}
