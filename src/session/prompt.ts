import type { Plugin } from "@opencode/plugin";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import type { Hooks } from "@opencode-ai/plugin";
import type { Part, UserMessage } from "@opencode-ai/sdk";
import { CompatibilityError } from "../domains/value.js";
import { promptOverrides } from "../client/state.js";
import { BridgeError } from "../client/errors.js";
import { assertNever } from "../client/errors.js";

export async function transformPrompt(context: Plugin.Context, event: SessionPrompt, hooks: Hooks): Promise<void> {
  if (hooks["chat.message"] === undefined) return;
  const session = await context.session.get({ sessionID: event.sessionID });
  const selected = session.model ?? (await context.model.default({ location: { directory: context.location.directory } })).data;
  if (selected === null) throw new BridgeError(404, "No default model is available for this session");
  const model = { providerID: selected.providerID, modelID: selected.id };
  const identity = { sessionID: event.sessionID, messageID: event.messageID };
  const message: UserMessage = { id: event.messageID, sessionID: event.sessionID, role: "user", time: { created: Date.now() }, agent: session.agent ?? "", model };
  const parts: Part[] = [{ ...identity, id: `${event.messageID}:text`, type: "text", text: event.prompt.text }];
  for (const [index, file] of (event.prompt.files ?? []).entries()) {
    parts.push({ ...identity, id: `${event.messageID}:file:${index}`, type: "file", mime: "application/octet-stream", url: file.uri,
      ...(file.name === undefined ? {} : { filename: file.name }) });
  }
  for (const [index, agent] of (event.prompt.agents ?? []).entries()) {
    parts.push({ ...identity, id: `${event.messageID}:agent:${index}`, type: "agent", name: agent.name });
  }
  const output = { message, parts };
  const variant = session.model?.variant;
  await hooks["chat.message"]({ sessionID: event.sessionID, agent: message.agent, model, messageID: event.messageID,
    ...(variant === undefined ? {} : { variant }) }, output);
  const texts: string[] = [];
  const files = [];
  const agents = [];
  for (const part of output.parts) {
    switch (part.type) {
      case "text": if (part.ignored !== true) texts.push(part.text); break;
      case "file": {
        const original = event.prompt.files?.find((_file, fileIndex) => part.id === `${event.messageID}:file:${fileIndex}`);
        const { name: _name, ...rest } = original ?? { uri: part.url };
        files.push({ ...rest, uri: part.url, ...(part.filename === undefined ? {} : { name: part.filename }) });
        break;
      }
      case "agent": {
        const original = event.prompt.agents?.find((_agent, index) => part.id === `${event.messageID}:agent:${index}`);
        agents.push({ ...original, name: part.name });
        break;
      }
      case "compaction": case "patch": case "reasoning": case "retry": case "snapshot":
      case "step-finish": case "step-start": case "subtask": case "tool":
        throw new CompatibilityError(`chat.message part ${part.type}`);
      default: assertNever(part);
    }
  }
  event.prompt.text = texts.join("\n");
  event.prompt.files = files;
  event.prompt.agents = agents;
  const updated = output.message;
  if (updated.agent !== "" && updated.agent !== session.agent) await context.session.switchAgent({ sessionID: event.sessionID, agent: updated.agent });
  if (updated.model.providerID !== selected?.providerID || updated.model.modelID !== selected.id) {
    await context.session.switchModel({ sessionID: event.sessionID, model: { providerID: updated.model.providerID, id: updated.model.modelID } });
  }
  if (updated.system !== undefined || updated.tools !== undefined) {
    const overrides = promptOverrides.parse(event.metadata?.["omsg.client"] ?? {});
    event.metadata = { ...event.metadata, "omsg.client": { ...overrides,
      ...(updated.system === undefined ? {} : { system: updated.system }), ...(updated.tools === undefined ? {} : { tools: updated.tools }) } };
  }
}
