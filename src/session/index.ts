import { Model, type Plugin } from "@opencode/plugin";
import type { SessionContext, SessionRequest } from "@opencode/plugin/promise/session";
import type { Hooks } from "@opencode-ai/plugin";
import type { ClientSessionState } from "../client/state.js";
import { ContentKind, SessionRequestKind } from "../enums.js";
import { offersVariant, requestContext } from "./model.js";
import { transformMessages } from "./messages.js";
import { transformPrompt } from "./prompt.js";

export async function registerSessions(
  context: Plugin.Context,
  hooks: Hooks,
  state: ClientSessionState,
): Promise<() => Promise<void>> {
  await using stack = new AsyncDisposableStack();
  const request = async (event: SessionRequest): Promise<void> => {
    const output = { system: event.system.map((part) => part.text) };
    if (hooks["experimental.chat.system.transform"] !== undefined) {
      const input = await requestContext(context, event);
      await hooks["experimental.chat.system.transform"](
        { sessionID: event.sessionID, model: input.model },
        output,
      );
      event.system = output.system.map((text, index) => ({
        ...event.system[index],
        type: ContentKind.Text,
        text,
      }));
    }
    await transformMessages(event, hooks);
  };
  stack.defer(
    (
      await context.session.hook("prompt", async (event) => {
        await transformPrompt(context, event, hooks);
        state.admit(event.sessionID, event.messageID);
      })
    ).dispose,
  );
  stack.defer(
    (
      await context.session.hook("experimental.idle", (event) => {
        state.settle(event.sessionID);
      })
    ).dispose,
  );
  stack.defer(
    (
      await context.session.hook("experimental.model.resolve", async (event) => {
        if (event.kind !== SessionRequestKind.Primary) return;
        const { sessionID } = event;
        const variant = await state.variant(sessionID, () =>
          context.session.context({ sessionID }),
        );
        if (
          variant === undefined ||
          variant === event.model.variant ||
          !(await offersVariant(context, event.model, variant))
        )
          return;
        event.model = Model.Ref.make({
          providerID: event.model.providerID,
          id: event.model.id,
          variant: Model.VariantID.make(variant),
        });
      })
    ).dispose,
  );
  const primary = async (event: SessionContext): Promise<void> => {
    state.apply(event);
    await request(event);
    if (hooks["chat.params"] !== undefined) {
      const input = await requestContext(context, event);
      const options = event.options;
      const output = {
        temperature: options.temperature ?? 1,
        topP: options.topP ?? 1,
        topK: options.topK ?? 0,
        maxOutputTokens: options.maxTokens,
        options: { ...options },
      };
      await hooks["chat.params"](input, output);
      Object.assign(options, output.options);
      if (options.temperature !== undefined || output.temperature !== 1)
        options.temperature = output.temperature;
      if (options.topP !== undefined || output.topP !== 1) options.topP = output.topP;
      if (options.topK !== undefined || output.topK !== 0) options.topK = output.topK;
      if (output.maxOutputTokens === undefined) delete options.maxTokens;
      else options.maxTokens = output.maxOutputTokens;
    }
  };
  stack.defer((await context.session.hook("context", primary)).dispose);
  stack.defer((await context.session.hook("generate", primary)).dispose);
  stack.defer((await context.session.hook("title", request)).dispose);
  stack.defer(
    (
      await context.session.hook("compaction", async (event) => {
        await primary(event);
        const output: { context: string[]; prompt?: string } = { context: [] };
        await hooks["experimental.session.compacting"]?.({ sessionID: event.sessionID }, output);
        if (output.prompt !== undefined)
          event.system = [{ type: ContentKind.Text, text: output.prompt }];
        event.system.push(...output.context.map((text) => ({ type: ContentKind.Text, text })));
      })
    ).dispose,
  );
  stack.defer(
    (
      await context.session.hook("model.request", async (event) => {
        if (hooks["chat.headers"] === undefined) return;
        const output = { headers: { ...event.headers } };
        await hooks["chat.headers"](await requestContext(context, event), output);
        event.headers = output.headers;
      })
    ).dispose,
  );
  const owned = stack.move();
  return () => owned.disposeAsync();
}
