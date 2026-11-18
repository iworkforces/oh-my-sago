import type { SessionContext } from "@opencode/plugin/promise/session";
import type { z } from "zod";
import { ContentKind } from "../enums.js";
import { nativeAction } from "../domains/permissions.js";
import { legacyName } from "../domains/value.js";
import { MessageRole } from "../enums.js";
import { type permission, promptBody } from "./requests.js";

export const promptOverrides = promptBody
  .pick({
    system: true,
    tools: true,
    temperature: true,
    topP: true,
    topK: true,
    maxOutputTokens: true,
    options: true,
    params: true,
  })
  .strip();
export type PromptOverrides = z.infer<typeof promptOverrides>;

export function permissionRules(rules: readonly z.infer<typeof permission>[]) {
  return rules.map((rule) => ({
    action: nativeAction(rule.permission),
    resource: rule.pattern,
    effect: rule.action,
  }));
}

/** Parent session hooks apply this state after their own legacy transformations. */
export class ClientSessionState {
  readonly #pending = new Map<string, PromptOverrides>();

  set(sessionID: string, overrides: PromptOverrides): void {
    this.#pending.set(sessionID, overrides);
  }
  delete(sessionID: string): void {
    this.#pending.delete(sessionID);
  }

  apply(event: SessionContext): void {
    const stored = event.messages.findLast(
      (message) =>
        message.role === MessageRole.User && message.metadata?.["omsg.client"] !== undefined,
    );
    const overrides =
      stored === undefined
        ? this.#pending.get(event.sessionID)
        : promptOverrides.parse(stored.metadata?.["omsg.client"]);
    if (overrides === undefined) return;
    if (overrides.system !== undefined)
      event.system.push({ type: ContentKind.Text, text: overrides.system });
    const { system: _system, tools, options, params, maxOutputTokens, ...generation } = overrides;
    Object.assign(event.options, options, params, generation);
    if (maxOutputTokens !== undefined) event.options.maxTokens = maxOutputTokens;
    for (const name of Object.keys(event.tools)) {
      if (tools?.[legacyName(name)] === false || tools?.[name] === false) delete event.tools[name];
    }
  }
}
