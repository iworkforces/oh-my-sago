import type { SessionMessageInfo } from "@opencode/client";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { z } from "zod";
import { type NativePermission, nativeAction } from "../domains/permissions.js";
import { legacyName } from "../domains/value.js";
import { ContentKind, MessageRole, RecordType } from "../enums.js";
import { type permission, promptBody } from "./requests.js";

export const clientMetadata = "omsago.client";

export const promptOverrides: z.ZodObject<
  Pick<
    (typeof promptBody)["shape"],
    | "system"
    | "tools"
    | "variant"
    | "temperature"
    | "topP"
    | "topK"
    | "maxOutputTokens"
    | "options"
    | "params"
  >
> = promptBody
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

/** The prompt overrides one primary request resolved; `undefined` when its user record had none. */
export type Turn = { readonly overrides: PromptOverrides | undefined };

/**
 * Hands each primary request the prompt overrides stored on the latest user record that existed
 * when its model was resolved. `experimental.model.resolve` records them and the same request's
 * `context` hook takes them, so no turn outlives the request that read it. Parent session hooks
 * apply them after their own legacy transformations. Also keeps each session's prompts admitted
 * without a reply, which OmO may send again to wake the session.
 */
export class ClientSessionState {
  readonly #resolved = new Map<string, Turn>();
  readonly #unanswered = new Map<string, Map<string, string>>();

  delete(sessionID: string): void {
    this.#resolved.delete(sessionID);
    this.#unanswered.delete(sessionID);
  }

  /**
   * Keeps the id of a prompt admitted without a reply under its text. OmO records a background
   * notice that way while the parent looks busy, then sends the same notice again to wake the
   * parent, possibly after other prompts without a reply. v2 keeps each in the session inbox until
   * a wake.
   */
  unanswered(sessionID: string, text: string, id: string): void {
    const prompts = this.#unanswered.get(sessionID) ?? new Map<string, string>();
    prompts.set(text, id);
    this.#unanswered.set(sessionID, prompts);
  }

  /** The id of the session's prompt admitted without a reply with this text, if any. */
  unansweredID(sessionID: string, text: string): string | undefined {
    return this.#unanswered.get(sessionID)?.get(text);
  }

  /** Forgets the session's prompts admitted without a reply, which a wake takes in. */
  answered(sessionID: string): void {
    this.#unanswered.delete(sessionID);
  }

  /** Reads the latest user record for a primary request and keeps its overrides for `take`. */
  async variant(
    sessionID: string,
    records: () => Promise<readonly SessionMessageInfo[]>,
  ): Promise<string | undefined> {
    // A request whose resolution fails must not leave an earlier request's turn behind.
    this.#resolved.delete(sessionID);
    const latest = (await records()).findLast((record) => record.type === RecordType.User);
    const turn = { overrides: storedOverrides(latest?.metadata) };
    this.#resolved.set(sessionID, turn);
    return turn.overrides?.variant;
  }

  /** Removes and returns the turn the session's latest primary resolution recorded. */
  take(sessionID: string): Turn | undefined {
    const turn = this.#resolved.get(sessionID);
    this.#resolved.delete(sessionID);
    return turn;
  }

  /**
   * Applies `turn`, or without one the overrides on the request's latest user message, as for
   * compaction and generate requests, which resolve no turn of their own.
   */
  apply(event: SessionContext, turn: Turn | undefined): void {
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
