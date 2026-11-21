import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Plugin } from "@opencode/plugin/tui";
import { type Toast, toastRpc } from "../src/toast.js";
import plugin from "../src/tui.js";

type ToastHandler = (event: { readonly data: Toast }) => void;

type Failure = "rpc" | "subscribe";

type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>;

// The routed session "ses_open" has a child "ses_child"; every other session is its own root.
const roots = new Map([["ses_child", "ses_open"]]);

function fakeHost(failure?: Failure) {
  const events = new EventEmitter();
  const rpc = new EventEmitter();
  const toasts: Parameters<Plugin.Context["ui"]["toast"]["show"]>[0][] = [];
  const error = new Error("toast forwarding unavailable");
  const router: { route: Route } = { route: { type: "session", sessionID: "ses_open" } };
  const context = {
    client: {
      rpc(definition: unknown) {
        assert.equal(definition, toastRpc);
        if (failure === "rpc") throw error;
        return {
          events: {
            on(name: "toast", handler: ToastHandler) {
              if (failure === "subscribe") throw error;
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
      session: {
        root(sessionID) {
          return roots.get(sessionID) ?? sessionID;
        },
      },
    },
    ui: {
      router: {
        current() {
          return router.route;
        },
      },
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
    readonly data: Pick<Plugin.Context["data"], "on"> & {
      readonly session: Pick<Plugin.Context["data"]["session"], "root">;
    };
    readonly ui: Pick<Plugin.Context["ui"], "toast"> & {
      readonly router: Pick<Plugin.Context["ui"]["router"], "current">;
    };
  };
  return { context, events, rpc, router, toasts, error };
}

async function load() {
  const { context, events, rpc, router, toasts } = fakeHost();
  // Exercise the exported definition with only the SDK capabilities it uses.
  const cleanup: unknown = await Reflect.apply(plugin.setup, undefined, [context]);
  assert.ok(typeof cleanup === "function");
  return {
    events,
    rpc,
    router,
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
  "TUI shows the success toast for the open session of %s",
  async (type) => {
    await using host = await load();

    host.events.emit(type, { data: { sessionID: "ses_child" } });

    expect(host.toasts).toEqual([
      {
        message: "Sago is now on Steroids, oMoMoMoMo...",
        variant: "success",
        duration: 5000,
        sessionID: "ses_child",
      },
    ]);
  },
);

test.each([
  ["session.created", "another session is open", { type: "session", sessionID: "ses_open" }],
  [
    "session.execution.succeeded",
    "another session is open",
    { type: "session", sessionID: "ses_open" },
  ],
  ["session.created", "no session is open", { type: "home" }],
  ["session.execution.succeeded", "no session is open", { type: "home" }],
] as const)("TUI does not show the success toast of %s while %s", async (type, _, route) => {
  await using host = await load();
  host.router.route = route;

  host.events.emit(type, { data: { sessionID: "ses_other" } });

  expect(host.toasts).toEqual([]);
});

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
    data: {
      title: "Background task",
      message: "done",
      variant: "info",
      duration: 3000,
      sessionID: "ses_child",
    },
  });
  host.rpc.emit("toast", { data: { message: "fallback model", variant: "warning" } });

  expect(host.toasts).toEqual([
    {
      title: "Background task",
      message: "done",
      variant: "info",
      duration: 3000,
      sessionID: "ses_child",
    },
    { message: "fallback model", variant: "warning" },
  ]);
});

test("TUI drops an OmO toast naming a session whose family is not open", async () => {
  await using host = await load();

  host.rpc.emit("toast", { data: { message: "done", variant: "info", sessionID: "ses_other" } });
  host.router.route = { type: "home" };
  host.rpc.emit("toast", { data: { message: "done", variant: "info", sessionID: "ses_open" } });

  expect(host.toasts).toEqual([]);
});

test("TUI shows an OmO toast naming no session whatever is open", async () => {
  await using host = await load();
  host.router.route = { type: "home" };

  host.rpc.emit("toast", { data: { message: "fallback model", variant: "warning" } });

  expect(host.toasts).toEqual([{ message: "fallback model", variant: "warning" }]);
});

test("TUI cleanup removes the OmO toast subscription", async () => {
  const host = await load();

  await host[Symbol.asyncDispose]();
  host.rpc.emit("toast", { data: { message: "late", variant: "error" } });

  expect(host.rpc.listenerCount("toast")).toBe(0);
  expect(host.toasts).toEqual([]);
});

test.each(["rpc", "subscribe"] as const)(
  "TUI setup unsubscribes its listeners and rethrows when the toast forwarding fails at %s",
  async (failure) => {
    const { context, events, rpc, error } = fakeHost(failure);

    let thrown: unknown;
    try {
      await Reflect.apply(plugin.setup, undefined, [context]);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBe(error);

    expect(events.listenerCount("session.created")).toBe(0);
    expect(events.listenerCount("session.execution.succeeded")).toBe(0);
    expect(rpc.listenerCount("toast")).toBe(0);
  },
);
