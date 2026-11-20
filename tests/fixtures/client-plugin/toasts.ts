import assert from "node:assert/strict";
import type { createClientBridge } from "../../../src/client/index.js";
import { ContentKind } from "../../../src/enums.js";
import type { Toast, ToastEmitter } from "../../../src/toast.js";
import { fixtureToast } from "./contracts.js";

type Client = ReturnType<typeof createClientBridge>["input"]["client"];

/** Prompt text whose `chat.message` hook requests the probe's toasts. */
export const toastPrompt = "CLIENT_TOAST";
export const hookToast = { ...fixtureToast, message: "toast from a session hook" } as const;
export const laterToast = { ...fixtureToast, message: "toast after a session hook" } as const;

export interface ToastProbe {
  readonly emitter: ToastEmitter;
  /** Called from a `chat.message` hook. */
  request(client: Client): void;
  verify(client: Client): Promise<"passed">;
}

/**
 * Records the toasts a bridge emits. A session hook requests two the way OmO does: one it does not
 * await, and one from work it leaves pending, like an OmO poller, that runs after the hook settled.
 */
export function toastProbe(toasts: ToastEmitter): ToastProbe {
  const emitted: Toast[] = [];
  const release = Promise.withResolvers<void>();
  let later: Promise<unknown> | undefined;
  const emitter: ToastEmitter = {
    async emit(...args) {
      emitted.push(args[1]);
      await toasts.emit(...args);
    },
  };
  return {
    emitter,
    request(client: Client): void {
      void client.tui.showToast({ body: hookToast });
      later ??= release.promise.then(() => client.tui.showToast({ body: laterToast }));
    },
    async verify(client: Client): Promise<"passed"> {
      const created = await client.session.create({ body: { title: "client toast" } });
      assert.ok(created.data, JSON.stringify(created.error));
      const reply = await client.session.prompt({
        path: { id: created.data.id },
        body: { parts: [{ type: ContentKind.Text, text: toastPrompt }] },
      });
      assert.ok(reply.data, JSON.stringify(reply.error));
      assert.ok(later !== undefined, "The chat.message hook requested no toast");
      release.resolve();
      await later;
      const shown = (message: string) => emitted.filter((toast) => toast.message === message);
      assert.deepEqual(shown(hookToast.message), [{ ...hookToast, sessionID: created.data.id }]);
      assert.deepEqual(shown(laterToast.message), [laterToast]);
      return "passed";
    },
  };
}
