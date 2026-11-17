import type { Plugin } from "@opencode/plugin";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import type { Model, UserMessage } from "@opencode-ai/sdk";
import type { Hooks, ProviderContext } from "@opencode-ai/plugin";
import { BridgeError } from "../client/errors.js";
import { legacyMessages } from "../client/messages.js";

export async function requestContext(
  context: Plugin.Context,
  request: Pick<SessionRequest, "sessionID" | "model"> & { readonly agent?: string },
): Promise<Parameters<NonNullable<Hooks["chat.params"]>>[0]> {
  const location = { directory: context.location.directory };
  const [models, providers, session, records] = await Promise.all([
    context.model.list({ location }), context.provider.list({ location }),
    context.session.get({ sessionID: request.sessionID }), context.session.context({ sessionID: request.sessionID }),
  ]);
  const selected = models.data.find((model) => model.id === request.model.id && model.providerID === request.model.providerID);
  const owner = providers.data.find((provider) => provider.id === request.model.providerID);
  if (selected === undefined || owner === undefined) throw new BridgeError(404, `Unknown model ${request.model.providerID}/${request.model.id}`);
  const cost = selected.cost.find((tier) => tier.tier === undefined);
  const options = { ...owner.settings, ...owner.body, ...selected.settings, ...selected.body };
  const baseURL = options["baseURL"];
  const model: Model = {
    id: selected.id, providerID: selected.providerID, name: selected.name,
    api: { id: selected.modelID, npm: selected.package ?? owner.package, url: typeof baseURL === "string" ? baseURL : "" },
    capabilities: {
      temperature: selected.capabilities.temperature === true, reasoning: selected.variants.length > 0,
      attachment: selected.capabilities.input.some((format) => format !== "text"), toolcall: selected.capabilities.tools,
      input: { text: selected.capabilities.input.includes("text"), audio: selected.capabilities.input.includes("audio"),
        image: selected.capabilities.input.includes("image"), video: selected.capabilities.input.includes("video"), pdf: selected.capabilities.input.includes("pdf") },
      output: { text: selected.capabilities.output.includes("text"), audio: selected.capabilities.output.includes("audio"),
        image: selected.capabilities.output.includes("image"), video: selected.capabilities.output.includes("video"), pdf: selected.capabilities.output.includes("pdf") },
    },
    cost: cost === undefined ? { input: 0, output: 0, cache: { read: 0, write: 0 } }
      : { input: cost.input, output: cost.output, cache: { ...cost.cache } },
    limit: selected.limit, status: selected.status, options, headers: { ...owner.headers, ...selected.headers },
  };
  const provider: ProviderContext = { source: "custom", options,
    info: { id: owner.id, name: owner.name, source: "custom", env: [], options, models: { [model.id]: model } } };
  const latest = legacyMessages(session, records).findLast((entry) => entry.info.role === "user");
  const message: UserMessage = latest?.info.role === "user" ? latest.info : {
    id: `${request.sessionID}:request`, sessionID: request.sessionID, role: "user", time: { created: session.time.created },
    agent: session.agent ?? "", model: { providerID: model.providerID, modelID: model.id },
  };
  return { sessionID: request.sessionID, agent: request.agent ?? session.agent ?? "", model, provider, message };
}
