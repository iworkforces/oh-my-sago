import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Plugin } from "@opencode/plugin/tui";
import { type Toast, toastRpc } from "../src/toast.js";
import plugin from "../src/tui.js";

type ToastHandler = (event: { readonly data: Toast }) => void;

async function load() {
  const events = new EventEmitter();
  const rpc = new EventEmitter();
  const toasts: Parameters<Plugin.Context["ui"]["toast"]["show"]>[0][] = [];
  const context = {
    client: {
      rpc(definition: unknown) {
        assert.equal(definition, toastRpc);
        return {
          events: {
            on(name: "toast", handler: ToastHandler) {
              rpc.on(name, handler);
              return () => {
                rpc.off(name, handler);
              };
            },
          },
        };
      },
    },
    data: {
      on(type, handler) {
        events.on(type, handler);
        return () => {
          events.off(type, handler);
        };
      },
    },
    ui: {
      toast: {
        show(options) {
          toasts.push(options);
        },
      },
    },
  } satisfies {
    readonly client: {
      rpc(definition: typeof toastRpc): {
        readonly events: { on(name: "toast", handler: ToastHandler): () => void };
      };
    };
    readonly data: Pick<Plugin.Context["data"], "on">;
    readonly ui: Pick<Plugin.Context["ui"], "toast">;
  };
  // Exercise the exported definition with only the SDK capabilities it uses.
  const cleanup: unknown = await Reflect.apply(plugin.setup, undefined, [context]);
  assert.ok(typeof cleanup === "function");
  return {
    events,
    rpc,
    toasts,
    async [Symbol.asyncDispose]() {
      await Reflect.apply(cleanup, undefined, []);
    },
  };
}

test("TUI setup waits for a session event before showing a toast", async () => {
  await using host = await load();

  expect(host.toasts).toEqual([]);
});

test.each(["session.created", "session.execution.succeeded"])(
  "TUI shows the success toast on %s",
  async (type) => {
    await using host = await load();

    host.events.emit(type);

    expect(host.toasts).toEqual([
      {
        message: "Sago is now on Steroids, oMoMoMoMo...",
        variant: "success",
        duration: 5000,
      },
    ]);
  },
);

test.each(["session.execution.failed", "session.execution.interrupted"])(
  "TUI does not show a success toast on %s",
  async (type) => {
    await using host = await load();

    host.events.emit(type);

    expect(host.toasts).toEqual([]);
  },
);

test.each(["session.created", "session.execution.succeeded"])(
  "TUI cleanup stops toasts on %s",
  async (type) => {
    const host = await load();

    await host[Symbol.asyncDispose]();
    host.events.emit(type);

    expect(host.toasts).toEqual([]);
  },
);

test("TUI forwards each OmO toast event to the toast API unchanged", async () => {
  await using host = await load();

  host.rpc.emit("toast", {
    data: { title: "Background task", message: "done", variant: "info", duration: 3000 },
  });
  host.rpc.emit("toast", { data: { message: "fallback model", variant: "warning" } });

  expect(host.toasts).toEqual([
    { title: "Background task", message: "done", variant: "info", duration: 3000 },
    { message: "fallback model", variant: "warning" },
  ]);
});

test("TUI cleanup removes the OmO toast subscription", async () => {
  const host = await load();

  await host[Symbol.asyncDispose]();
  host.rpc.emit("toast", { data: { message: "late", variant: "error" } });

  expect(host.rpc.listenerCount("toast")).toBe(0);
  expect(host.toasts).toEqual([]);
});
