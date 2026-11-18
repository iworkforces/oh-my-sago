import type { SessionMessageInfo } from "@opencode/client";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { z } from "zod";
import { type NativePermission, nativeAction } from "../domains/permissions.js";
import { legacyName } from "../domains/value.js";
import { ContentKind, MessageRole, RecordType } from "../enums.js";
import { type permission, promptBody } from "./requests.js";

export const clientMetadata = "omsago.client";

export const promptOverrides = promptBody
  .pick({
    system: true,
    tools: true,
    variant: true,
    temperature: true,
    topP: true,
    topK: true,
    maxOutputTokens: true,
    options: true,
    params: true,
  })
  .strip();
export type PromptOverrides = z.infer<typeof promptOverrides>;

export function permissionRules(rules: readonly z.infer<typeof permission>[]): NativePermission[] {
  return rules.map((rule) => ({
    action: nativeAction(rule.permission),
    resource: rule.pattern,
    effect: rule.action,
  }));
}

function storedOverrides(metadata: Readonly<Record<string, unknown>> | undefined) {
  const stored = metadata?.[clientMetadata];
  return stored === undefined ? undefined : promptOverrides.parse(stored);
}

type Turn = { readonly messageID: string; readonly overrides: PromptOverrides | undefined };

/**
 * Tracks the user message that started each session's current turn, so prompt overrides and the
 * variant apply to that turn only. Parent session hooks apply it after their own legacy
 * transformations.
 */
export class ClientSessionState {
  readonly #admitted = new Map<string, string[]>();
  readonly #current = new Map<string, Turn>();

  admit(sessionID: string, messageID: string): void {
    this.#admitted.set(sessionID, [...(this.#admitted.get(sessionID) ?? []), messageID]);
  }
  delete(sessionID: string): void {
    this.#admitted.delete(sessionID);
    this.#current.delete(sessionID);
  }
  settle(sessionID: string): void {
    this.#current.delete(sessionID);
  }

  /** Records are read only when no turn is cached or an admitted prompt may have started one. */
  async variant(
    sessionID: string,
    records: () => Promise<readonly SessionMessageInfo[]>,
  ): Promise<string | undefined> {
    let turn = this.#current.get(sessionID);
    if (turn === undefined || this.#admitted.has(sessionID)) {
      const latest = (await records()).findLast((record) => record.type === RecordType.User);
      if (latest !== undefined) {
        const admitted = this.#admitted.get(sessionID) ?? [];
        const pending = admitted.slice(admitted.indexOf(latest.id) + 1);
        if (pending.length === 0) this.#admitted.delete(sessionID);
        else this.#admitted.set(sessionID, pending);
        turn = { messageID: latest.id, overrides: storedOverrides(latest.metadata) };
        this.#current.set(sessionID, turn);
      }
    }
    return turn?.overrides?.variant;
  }

  apply(event: SessionContext): void {
    const turn = this.#current.get(event.sessionID);
    const overrides =
      turn === undefined
        ? storedOverrides(
            event.messages.findLast((message) => message.role === MessageRole.User)?.metadata,
          )
        : turn.overrides;
    if (overrides === undefined) return;
    if (overrides.system !== undefined)
      event.system.push({ type: ContentKind.Text, text: overrides.system });
    const {
      system: _system,
      variant: _variant,
      tools,
      options,
      params,
      maxOutputTokens,
      ...generation
    } = overrides;
    Object.assign(event.options, options, params, generation);
    if (maxOutputTokens !== undefined) event.options.maxTokens = maxOutputTokens;
    for (const name of Object.keys(event.tools)) {
      if (tools?.[legacyName(name)] === false || tools?.[name] === false) delete event.tools[name];
    }
  }
}
