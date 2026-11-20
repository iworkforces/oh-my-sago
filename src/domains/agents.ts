import type { AgentConfig, Config } from "@opencode-ai/sdk";
import { Agent, Model, type Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { z } from "zod";
import { AgentMode, PermissionEffect, permissionEffects } from "../enums.js";
import { type NativePermission, nativeAction, nativePermissions } from "./permissions.js";
import { errorMessage, jsonRecord } from "./value.js";

/** Every legacy agent field the update applies, including the extras the SDK type omits. */
const agentSettings = z.object({
  prompt: z.string().optional(),
  description: z.string().optional(),
  mode: z.enum(AgentMode).optional(),
  color: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  hidden: z.boolean().optional(),
  variant: z.string().optional(),
  steps: z.number().int().positive().optional(),
  options: jsonRecord.optional(),
});

const toolToggles = z.record(z.string(), z.boolean());

/** A legacy agent entry whose every field already parsed, so applying it cannot throw. */
interface AgentOverride {
  readonly name: Agent.Name;
  readonly settings: z.infer<typeof agentSettings>;
  readonly model: Agent.Info["model"];
  readonly permissions: readonly NativePermission[];
}

const effect = z.enum(permissionEffects);

/**
 * Parses the top-level rules one entry at a time, so one bad rule cannot fail setup. Skipping it
 * would widen every agent, so an invalid effect denies its action and resource, and an entry of
 * the wrong shape denies its action for every resource.
 */
function globalPermissions(value: unknown): NativePermission[] {
  if (value === undefined) return [];
  const entries: [string, unknown][] =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.entries(value)
      : [["*", value]];
  const denied = (action: string, resource: string, rule: unknown): NativePermission => {
    console.warn("omsago: Denying an invalid permission rule", {
      permission: action,
      resource,
      rule: JSON.stringify(rule) ?? String(rule),
    });
    return { action: nativeAction(action), resource, effect: PermissionEffect.Deny };
  };
  return entries.flatMap(([action, rule]): NativePermission[] => {
    if (typeof rule === "string") {
      const parsed = effect.safeParse(rule);
      return [
        parsed.success
          ? { action: nativeAction(action), resource: "*", effect: parsed.data }
          : denied(action, "*", rule),
      ];
    }
    if (typeof rule !== "object" || rule === null || Array.isArray(rule))
      return [denied(action, "*", rule)];
    return Object.entries(rule).map(([resource, decision]) => {
      const parsed = effect.safeParse(decision);
      return parsed.success
        ? { action: nativeAction(action), resource, effect: parsed.data }
        : denied(action, resource, decision);
    });
  });
}

function prepareAgent(
  name: string,
  definition: AgentConfig,
  global: readonly NativePermission[],
): AgentOverride {
  const settings = agentSettings.parse(definition);
  const tools = toolToggles.parse(definition.tools ?? {});
  return {
    name: Agent.Name.make(name),
    settings,
    model:
      definition.model === undefined || definition.model === ""
        ? undefined
        : {
            ...Model.Ref.parse(definition.model),
            ...(settings.variant === undefined
              ? {}
              : { variant: Model.VariantID.make(settings.variant) }),
          },
    permissions: [
      ...global,
      ...nativePermissions(
        Object.fromEntries(
          Object.entries(tools).map(([tool, enabled]) => [
            tool,
            enabled ? PermissionEffect.Allow : PermissionEffect.Deny,
          ]),
        ),
      ),
      ...nativePermissions(definition.permission),
    ],
  };
}

export async function registerAgents(
  context: Plugin.Context,
  config: Config,
): Promise<Registration> {
  const selection = z.object({ default_agent: z.string().optional() }).safeParse(config);
  const requested = selection.success ? selection.data.default_agent : undefined;
  if (!selection.success)
    console.warn("omsago: Ignoring a default_agent that is not an agent name", {
      reason: selection.error.message,
    });
  let defaultAgent = requested;
  const global = globalPermissions(config.permission);
  const removals: string[] = [];
  const overrides: AgentOverride[] = [];
  for (const [name, definition] of Object.entries(config.agent ?? {})) {
    if (definition === undefined) continue;
    if (definition.disable === true) {
      removals.push(name);
      continue;
    }
    try {
      overrides.push(prepareAgent(name, definition, global));
    } catch (error) {
      if (name === defaultAgent) defaultAgent = undefined;
      // Keeping a native agent that the config meant to restrict would widen its access.
      console.warn("omsago: Removing agent with an invalid definition", {
        agent: name,
        reason: errorMessage(error),
      });
      removals.push(name);
    }
  }
  return context.agent.transform((editor) => {
    for (const name of removals) editor.remove(name);
    for (const { name, settings, model, permissions } of overrides) {
      editor.update(name, (agent) => {
        agent.name = name;
        if (model !== undefined) agent.model = model;
        if (settings.prompt !== undefined) agent.system = settings.prompt;
        if (settings.description !== undefined) agent.description = settings.description;
        if (settings.mode !== undefined) agent.mode = settings.mode;
        if (settings.hidden !== undefined) agent.hidden = settings.hidden;
        if (settings.color !== undefined) agent.color = settings.color;
        const steps = settings.steps ?? settings.maxSteps;
        if (steps !== undefined) agent.steps = steps;
        agent.request.body = {
          ...agent.request.body,
          ...settings.options,
          ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
          ...(settings.top_p === undefined ? {} : { top_p: settings.top_p }),
        };
        agent.permissions.push(...permissions);
      });
    }
    if (defaultAgent === undefined || editor.get(defaultAgent) === undefined) {
      if (requested !== undefined)
        console.warn("omsago: Keeping the native default agent", {
          default_agent: requested,
          reason: "it names no agent with a valid definition",
        });
      return;
    }
    editor.default(defaultAgent);
  });
}
