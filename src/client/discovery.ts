import type { Plugin } from "@opencode/plugin";
import type { AgentInfo, ModelInfo } from "@opencode/client";
import type { Agent, Config, Project, ProviderListResponse } from "@opencode-ai/sdk";
import { NativeAction, PermissionEffect } from "../enums.js";
import { unsupported } from "./errors.js";

export function currentProject(context: Plugin.Context): Project {
  return {
    id: context.location.project.id,
    worktree: context.location.project.directory,
    time: { created: 0 },
  };
}

function legacyAgent(agent: AgentInfo): Agent & { hidden: boolean; variant?: string } {
  const effect = (name: string) =>
    agent.permissions.findLast((rule) => rule.action === name && rule.resource === "*")?.effect ??
    PermissionEffect.Ask;
  return {
    name: agent.id,
    mode: agent.mode,
    builtIn: false,
    hidden: agent.hidden,
    permission: {
      edit: effect(NativeAction.Edit),
      bash: Object.fromEntries(
        agent.permissions
          .filter((rule) => rule.action === NativeAction.Shell)
          .map((rule) => [rule.resource, rule.effect]),
      ),
    },
    tools: Object.fromEntries(
      agent.permissions
        .filter((rule) => rule.resource === "*")
        .map((rule) => [rule.action, rule.effect !== PermissionEffect.Deny]),
    ),
    options: { ...agent.request.settings, ...agent.request.body },
    ...(agent.description === undefined ? {} : { description: agent.description }),
    ...(agent.system === undefined ? {} : { prompt: agent.system }),
    ...(agent.steps === undefined ? {} : { maxSteps: agent.steps }),
    ...(agent.model === undefined
      ? {}
      : {
          model: { providerID: agent.model.providerID, modelID: agent.model.id },
          ...(agent.model.variant === undefined ? {} : { variant: agent.model.variant }),
        }),
  };
}

function releaseDate(model: ModelInfo): string {
  const date = new Date(model.time.released);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  console.warn("omsago: Model has an invalid release date", {
    providerID: model.providerID,
    modelID: model.id,
    released: model.time.released,
  });
  return "";
}

function providerModel(model: ModelInfo) {
  const cost = model.cost.find((tier) => tier.tier === undefined);
  return {
    id: model.id,
    name: model.name,
    release_date: releaseDate(model),
    attachment: model.capabilities.input.some((input) => input !== "text"),
    reasoning: model.variants.length > 0,
    temperature: model.capabilities.temperature === true,
    tool_call: model.capabilities.tools,
    limit: model.limit,
    status: model.status,
    options: { ...model.settings, ...model.body },
    headers: model.headers ?? {},
    variants: Object.fromEntries(
      model.variants.map((variant) => [variant.id, { ...variant.settings, ...variant.body }]),
    ),
    ...(cost === undefined
      ? {}
      : {
          cost: {
            input: cost.input,
            output: cost.output,
            cache_read: cost.cache.read,
            cache_write: cost.cache.write,
          },
        }),
  };
}

export async function discoveryRoute(context: Plugin.Context, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const location = { directory: url.searchParams.get("directory") ?? context.location.directory };
  const options = { signal: request.signal };
  if (request.method !== "GET") return unsupported(`${request.method} ${url.pathname}`);
  switch (url.pathname) {
    case "/project/current":
      return Response.json(currentProject(context));
    case "/agent":
      return Response.json((await context.agent.list({ location }, options)).data.map(legacyAgent));
    case "/skill":
      return Response.json(
        (await context.skill.list({ location }, options)).data.map((skill) => ({
          name: skill.name,
          description: skill.description ?? "",
          location: skill.path,
          content: skill.content,
        })),
      );
    case "/config": {
      const selected = (await context.model.default({ location }, options)).data;
      const agents = (await context.agent.list({ location }, options)).data;
      const config: Config = {
        agent: Object.fromEntries(
          agents.map((agent) => [
            agent.id,
            {
              ...(agent.system === undefined ? {} : { prompt: agent.system }),
              mode: agent.mode,
              ...(agent.model === undefined
                ? {}
                : { model: `${agent.model.providerID}/${agent.model.id}` }),
              ...(agent.description === undefined ? {} : { description: agent.description }),
            },
          ]),
        ),
        ...(selected === null ? {} : { model: `${selected.providerID}/${selected.id}` }),
      };
      return Response.json(config);
    }
    case "/provider": {
      const providers = (await context.provider.list({ location }, options)).data;
      const models = (await context.model.list({ location }, options)).data;
      const selected = (await context.model.default({ location }, options)).data;
      const result: ProviderListResponse = {
        all: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          env: [],
          npm: provider.package,
          models: Object.fromEntries(
            models
              .filter((model) => model.providerID === provider.id)
              .map((model) => [model.id, providerModel(model)]),
          ),
        })),
        connected: providers
          .filter(
            (provider) =>
              provider.activation !== "disabled" &&
              models.some((model) => model.providerID === provider.id && model.enabled),
          )
          .map((provider) => provider.id),
        default: Object.fromEntries(
          providers.flatMap((provider) => {
            const model =
              selected?.providerID === provider.id
                ? selected
                : models.find(
                    (candidate) => candidate.providerID === provider.id && candidate.enabled,
                  );
            return model === undefined ? [] : [[provider.id, model.id]];
          }),
        ),
      };
      return Response.json(result);
    }
    default:
      return unsupported(`${request.method} ${url.pathname}`);
  }
}
