import { $ } from "bun";
import type { Plugin } from "@opencode/plugin";
import type { PluginInput, WorkspaceAdapter } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { createOpencodeClient as createSkillClient } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { type ToastEmitter, toast } from "../toast.js";
import { currentProject, discoveryRoute } from "./discovery.js";
import { BridgeError, errorResponse, unsupported } from "./errors.js";
import { type LegacyEventSink, clientEvents } from "./events.js";
import { body } from "./requests.js";
import { BackgroundWaits, SessionRetries } from "./sessions.js";
import { sessionRoutes } from "./session-routes.js";
import { raceAbort } from "./signal.js";
import { ClientSessionState } from "./state.js";
import { toastSession } from "./toast-session.js";

export type ClientBridge = {
  readonly input: PluginInput & {
    readonly client: PluginInput["client"] & {
      readonly app: PluginInput["client"]["app"] &
        Pick<ReturnType<typeof createSkillClient>["app"], "skills">;
    };
  };
  readonly sessionState: ClientSessionState;
  readonly start: (hooks: LegacyEventSink) => Promise<void>;
  /** Stops event delivery while the legacy client keeps answering requests. */
  readonly stop: () => Promise<void>;
  /**
   * Stops event delivery and OmO's loopback listener; idempotent. Later legacy client requests go to
   * an open bridge for the same directory, waiting for a reloaded one up to `successorMs`, and fail
   * with 503 when none opens.
   */
  readonly close: () => Promise<void>;
};

export type ClientBridgeOptions = {
  /** How long a closed bridge waits for an open one in its directory; defaults to 10 seconds. */
  readonly successorMs?: number;
};

type Route = (request: Request) => Promise<Response>;

/**
 * Open bridges by directory. The host closes a plugin before its reload finishes setup, and OmO work
 * from the closed instance, such as a tool call in a turn that started before the reload, still uses
 * that instance's client. A reload imports this module again, so the registry lives on `globalThis`
 * and holds only routes, which every version of this module calls the same way: a route answers by
 * method, path, query, headers and body, and ignores the origin, so the internal base URL is free to
 * change between versions. Versions up to 1.0.7 still require `http://omsago.invalid`, which is why
 * this one keeps sending it.
 */
const routesKey = Symbol.for("omsago.bridge.routes.v1");
/** The session loopback each directory's bridges share; see `leaseLoopback`. */
const loopbacksKey = Symbol.for("omsago.bridge.loopbacks.v1");
const successorPollMs = 50;

function isMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}

function isSet(value: unknown): value is Set<unknown> {
  return value instanceof Set;
}

function isRoute(value: unknown): value is Route {
  return typeof value === "function";
}

function sharedRegistry(key: symbol): Map<unknown, unknown> {
  const found: unknown = Reflect.get(globalThis, key);
  if (isMap(found)) return found;
  const registry = new Map<unknown, unknown>();
  Reflect.set(globalThis, key, registry);
  return registry;
}

function routeRegistry(): Map<unknown, unknown> {
  return sharedRegistry(routesKey);
}

function register(directory: string, route: Route): () => void {
  const registry = routeRegistry();
  const existing = registry.get(directory);
  const routes = isSet(existing) ? existing : new Set<unknown>();
  routes.add(route);
  registry.set(directory, routes);
  return () => {
    routes.delete(route);
    if (routes.size === 0 && registry.get(directory) === routes) registry.delete(directory);
  };
}

function successor(directory: string, own: Route): Route | undefined {
  const routes = routeRegistry().get(directory);
  if (!isSet(routes)) return undefined;
  let found: Route | undefined;
  for (const route of routes) if (route !== own && isRoute(route)) found = route;
  return found;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

type Listener = { readonly url: URL; readonly stop: () => Promise<void> };

/**
 * OmO lists sessions through its own global-fetch client on `serverUrl` and uses the plugin client
 * only when that one reports NotFoundError, so it gets a loopback listener that answers every
 * request that way. Its /global/health probes read the 404 as no server running.
 */
function notFoundListener(): Listener | undefined {
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        errorResponse(new BridgeError(404, "omsago serves sessions through the plugin client")),
    });
  } catch (error) {
    console.warn("omsago: OmO session tools fall back to the placeholder serverUrl", error);
    return undefined;
  }
  server.unref();
  let stopped: Promise<void> | undefined;
  return {
    url: server.url,
    stop: () => {
      stopped ??= server.stop(true);
      return stopped;
    },
  };
}

/** A directory's loopback, shared on `globalThis` with every version of this module. */
interface Loopback extends Listener {
  readonly holders: Set<unknown>;
  expiry: ReturnType<typeof setTimeout> | undefined;
}

function isLoopback(value: unknown): value is Loopback {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "url") instanceof URL &&
    isSet(Reflect.get(value, "holders")) &&
    typeof Reflect.get(value, "stop") === "function"
  );
}

type Lease = {
  readonly url: URL;
  /** Drops this hold; the last one stops the listener after `graceMs`, or at once when it is 0. */
  readonly release: (graceMs: number) => Promise<void>;
};

/**
 * OmO keeps the `serverUrl` its runtime started with, so a closed instance's session tools still
 * call it after a reload. The bridges of one directory therefore share one listener, which outlives
 * the last of them by the hand-off window: a reloaded bridge adopts it, and the closed runtime keeps
 * an address that answers rather than one that refuses and sends OmO to its file storage.
 */
function leaseLoopback(directory: string, placeholder: URL): Lease {
  const loopbacks = sharedRegistry(loopbacksKey);
  const found = loopbacks.get(directory);
  let loopback: Loopback;
  if (isLoopback(found)) loopback = found;
  else {
    const listener = notFoundListener();
    if (listener === undefined) return { url: placeholder, release: () => Promise.resolve() };
    loopback = { url: listener.url, stop: listener.stop, holders: new Set(), expiry: undefined };
    loopbacks.set(directory, loopback);
  }
  clearTimeout(loopback.expiry);
  loopback.expiry = undefined;
  const holder = Symbol("omsago.bridge.loopback.holder");
  loopback.holders.add(holder);
  const stop = (): Promise<void> => {
    if (loopbacks.get(directory) === loopback) loopbacks.delete(directory);
    return loopback.stop();
  };
  return {
    url: loopback.url,
    release: async (graceMs) => {
      if (!loopback.holders.delete(holder) || loopback.holders.size > 0) return;
      clearTimeout(loopback.expiry);
      loopback.expiry = undefined;
      if (graceMs <= 0) {
        await stop();
        return;
      }
      loopback.expiry = setTimeout(() => {
        loopback.expiry = undefined;
        if (loopback.holders.size > 0) return;
        stop().catch((error: unknown) => {
          console.warn("omsago: Could not stop the session loopback", error);
        });
      }, graceMs);
      loopback.expiry.unref();
    },
  };
}

export function createClientBridge(
  context: Plugin.Context,
  toasts: ToastEmitter,
  options: ClientBridgeOptions = {},
): ClientBridge {
  const successorMs = options.successorMs ?? 10_000;
  const directory = context.location.directory;
  const sessionState = new ClientSessionState();
  const retries = new SessionRetries();
  const waits = new BackgroundWaits();
  const sessions = sessionRoutes(context, sessionState, retries, waits);
  const events = clientEvents(context, retries, waits, sessionState);
  let closed = false;
  const showToast = async (request: Request): Promise<Response> => {
    // Read before awaiting: the attribution ends soon after the hook that requested the toast.
    const sessionID = toastSession();
    const input = await body(request, toast);
    try {
      await toasts.emit("toast", sessionID === undefined ? input : { ...input, sessionID });
    } catch (error) {
      console.error("Client bridge could not deliver a toast", error);
    }
    return Response.json(true);
  };
  const internalUrl = new URL("http://omsago.invalid");
  const loopback = leaseLoopback(directory, internalUrl);
  const route = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (path[0] === "session") return await sessions(request, path);
      if (request.method === "POST" && url.pathname === "/tui/show-toast")
        return await showToast(request);
      return await discoveryRoute(context, request);
    } catch (error) {
      if (request.signal.aborted || !(error instanceof Error)) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError)
        return errorResponse(new BridgeError(400, error.message));
      return errorResponse(error);
    }
  };
  const handOff = async (request: Request): Promise<Response> => {
    const deadline = Date.now() + successorMs;
    for (;;) {
      const next = successor(directory, forward);
      if (next !== undefined) return await next(request);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new BridgeError(503, "The client bridge is closed");
      await raceAbort(request.signal, pause(Math.min(successorPollMs, remaining)));
    }
  };
  // The caller stops waiting while the route runs on; only POST /session/:id/abort interrupts.
  const forward: Route = (request) =>
    closed ? handOff(request) : raceAbort(request.signal, route(request));
  const unregister = register(directory, forward);
  const transport = async (
    input: string | Request | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? init === undefined
          ? input
          : new Request(input, init)
        : new Request(input.toString(), init);
    request.signal.throwIfAborted();
    // Only this client's own requests carry an origin worth checking; see the route registry.
    if (new URL(request.url).origin !== internalUrl.origin)
      return errorResponse(new BridgeError(400, "The client bridge cannot route a foreign origin"));
    return forward(request);
  };
  const config = {
    baseUrl: internalUrl.href,
    directory,
    fetch: Object.assign(transport, {
      preconnect() {
        unsupported("fetch.preconnect");
      },
    }),
  };
  const client = createOpencodeClient(config);
  const skillClient = createSkillClient(config);
  const app = Object.assign(client.app, { skills: skillClient.app.skills.bind(skillClient.app) });
  const input = {
    client: Object.assign(client, { app }),
    project: currentProject(context),
    directory,
    worktree: context.location.project.directory,
    serverUrl: loopback.url,
    $,
    experimental_workspace: {
      register(_type: string, _adapter: WorkspaceAdapter) {
        unsupported("experimental_workspace.register");
      },
    },
  } satisfies PluginInput;
  return {
    input,
    sessionState,
    start: (hooks: LegacyEventSink) => events.start(hooks),
    stop: async () => {
      await events.stop();
      retries.stop();
      waits.clear();
    },
    close: async () => {
      closed = true;
      unregister();
      await loopback.release(successorMs);
      await events.stop();
      retries.stop();
      waits.clear();
    },
  };
}
