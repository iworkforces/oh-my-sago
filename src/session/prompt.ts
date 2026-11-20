import type { Plugin } from "@opencode/plugin";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import type { Hooks } from "@opencode-ai/plugin";
import type { Part, UserMessage } from "@opencode-ai/sdk";
import { CompatibilityError } from "../domains/value.js";
import { clientMetadata, promptOverrides } from "../client/state.js";
import { BridgeError } from "../client/errors.js";
import { assertNever } from "../client/errors.js";
import { MessageRole, PartKind } from "../enums.js";
import { applySwitch, resolveSwitch } from "./model.js";

export async function transformPrompt(
  context: Plugin.Context,
  event: SessionPrompt,
  hooks: Hooks,
): Promise<void> {
  if (hooks["chat.message"] === undefined) return;
  const session = await context.session.get({ sessionID: event.sessionID });
  const selected =
    session.model ??
    (await context.model.default({ location: { directory: context.location.directory } })).data;
  if (selected === null)
    throw new BridgeError(404, "No default model is available for this session");
  const model = { providerID: selected.providerID, modelID: selected.id };
  const identity = { sessionID: event.sessionID, messageID: event.messageID };
  const stored = promptOverrides.parse(event.metadata?.[clientMetadata] ?? {});
  const message: UserMessage & { variant?: unknown } = {
    id: event.messageID,
    sessionID: event.sessionID,
    role: MessageRole.User,
    time: { created: Date.now() },
    agent: session.agent ?? "",
    model,
    ...(stored.variant === undefined ? {} : { variant: stored.variant }),
  };
  const parts: Part[] = [
    { ...identity, id: `${event.messageID}:text`, type: PartKind.Text, text: event.prompt.text },
  ];
  for (const [index, file] of (event.prompt.files ?? []).entries()) {
    parts.push({
      ...identity,
      id: `${event.messageID}:file:${index}`,
      type: PartKind.File,
      mime: "application/octet-stream",
      url: file.uri,
      ...(file.name === undefined ? {} : { filename: file.name }),
    });
  }
  for (const [index, agent] of (event.prompt.agents ?? []).entries()) {
    parts.push({
      ...identity,
      id: `${event.messageID}:agent:${index}`,
      type: PartKind.Agent,
      name: agent.name,
    });
  }
  const output = { message, parts };
  const variant = stored.variant ?? session.model?.variant;
  await hooks["chat.message"](
    {
      sessionID: event.sessionID,
      agent: message.agent,
      model,
      messageID: event.messageID,
      ...(variant === undefined ? {} : { variant }),
    },
    output,
  );
  const texts: string[] = [];
  const files = [];
  const agents = [];
  for (const part of output.parts) {
    switch (part.type) {
      case PartKind.Text:
        if (part.ignored !== true) texts.push(part.text);
        break;
      case PartKind.File: {
        const original = event.prompt.files?.find(
          (_file, fileIndex) => part.id === `${event.messageID}:file:${fileIndex}`,
        );
        const { name: _name, ...rest } = original ?? { uri: part.url };
        files.push({
          ...rest,
          uri: part.url,
          ...(part.filename === undefined ? {} : { name: part.filename }),
        });
        break;
      }
      case PartKind.Agent: {
        const original = event.prompt.agents?.find(
          (_agent, index) => part.id === `${event.messageID}:agent:${index}`,
        );
        agents.push({ ...original, name: part.name });
        break;
      }
      case PartKind.Compaction:
      case PartKind.Patch:
      case PartKind.Reasoning:
      case PartKind.Retry:
      case PartKind.Snapshot:
      case PartKind.StepFinish:
      case PartKind.StepStart:
      case PartKind.Subtask:
      case PartKind.Tool:
        throw new CompatibilityError(`chat.message part ${part.type}`);
      default:
        assertNever(part);
    }
  }
  const updated = output.message;
  const switching = await resolveSwitch(context, event.sessionID, {
    agent: updated.agent !== "" && updated.agent !== session.agent ? updated.agent : undefined,
    model:
      updated.model.providerID !== selected.providerID || updated.model.modelID !== selected.id
        ? { providerID: updated.model.providerID, id: updated.model.modelID }
        : undefined,
  });
  await applySwitch(context, event.sessionID, switching);
  event.prompt.text = texts.join("\n");
  event.prompt.files = files;
  event.prompt.agents = agents;
  const chosen = typeof updated.variant === "string" ? updated.variant : undefined;
  if (updated.system !== undefined || updated.tools !== undefined || chosen !== stored.variant) {
    const { variant: _variant, ...overrides } = stored;
    event.metadata = {
      ...event.metadata,
      [clientMetadata]: {
        ...overrides,
        ...(updated.system === undefined ? {} : { system: updated.system }),
        ...(updated.tools === undefined ? {} : { tools: updated.tools }),
        ...(chosen === undefined ? {} : { variant: chosen }),
      },
    };
  }
}
