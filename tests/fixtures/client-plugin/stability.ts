import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import type { SessionInfo } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import { Location } from "@opencode/schema/location";
import { z } from "zod";
import { BridgeError } from "../../../src/client/errors.js";
import { clientEvents } from "../../../src/client/events.js";
import { createClientBridge } from "../../../src/client/index.js";
import { type RetryStatus, SessionRetries } from "../../../src/client/sessions.js";
import { sessionRoutes } from "../../../src/client/session-routes.js";
import { ClientSessionState } from "../../../src/client/state.js";
import {
  ContentKind,
  ErrorName,
  LegacyEventType,
  MessageRole,
  SessionEventType,
  SessionStatusKind,
} from "../../../src/enums.js";
import { EventLog, idleOf } from "./events.js";
import type { ClientModel } from "./model.js";
import { settledOrder } from "./turns.js";

type Bridge = ReturnType<typeof createClientBridge>;
type Outcome = { readonly done: true; readonly value: undefined };
const sessionData = z.object({ sessionID: z.string() });
const pendingRetry: RetryStatus = {
  type: SessionStatusKind.Retry,
  attempt: 1,
  message: "fixture retry",
  next: 1,
};

/** Gives a session an entry in both per-session stores a deletion must clear. */
async function remember(
  state: ClientSessionState,
  retries: SessionRetries,
  sessionID: string,
): Promise<void> {
  await state.variant(sessionID, () => Promise.resolve([]));
  retries.set(sessionID, pendingRetry);
}

function forgotten(state: ClientSessionState, retries: SessionRetries, sessionID: string): boolean {
  return state.take(sessionID) === undefined && !retries.clear(sessionID);
}

/** A native event stream the fixture can end, fail or hold down, counting what it delivers. */
class FlakyStream {
  down = false;
  /** Relayed subscriptions their consumer has not closed yet. */
  active = 0;
  readonly delivered = new Map<string, number>();
  readonly #pulled = new Map<string, PromiseWithResolvers<void>>();
  #cut: PromiseWithResolvers<Outcome> | undefined;
  #reopened = Promise.withResolvers<void>();

  readonly subscribe: Plugin.Context["event"]["subscribe"];

  constructor(context: Plugin.Context) {
    this.subscribe = (options) => this.#relay(() => context.event.subscribe(options));
  }

  /** Settles once a subscription opened after the last `end` or `fail` is delivering. */
  reopened(): Promise<void> {
    return this.#reopened.promise;
  }

  /** Settles once the consumer has taken the session's next event of this type and asked for more. */
  pulled(sessionID: string, type: string): Promise<void> {
    const waiter = Promise.withResolvers<void>();
    this.#pulled.set(`${sessionID} ${type}`, waiter);
    return waiter.promise;
  }

  end(): void {
    this.#reopened = Promise.withResolvers<void>();
    this.#cut?.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    this.#reopened = Promise.withResolvers<void>();
    this.#cut?.reject(error);
  }

  async *#relay<Event extends { readonly type: string }>(
    open: () => AsyncIterable<Event>,
  ): AsyncGenerator<Event, void> {
    if (this.down) throw new Error("fixture event stream is down");
    const cut = Promise.withResolvers<Outcome>();
    this.#cut = cut;
    const iterator = open()[Symbol.asyncIterator]();
    this.active++;
    try {
      const first = iterator.next();
      this.#reopened.resolve();
      for (let next = await Promise.race([first, cut.promise]); next.done !== true;) {
        const event: { readonly type: string; readonly data?: unknown } = next.value;
        const sessionID = sessionData.parse(event.data).sessionID;
        this.delivered.set(sessionID, (this.delivered.get(sessionID) ?? 0) + 1);
        yield next.value;
        const key = `${sessionID} ${event.type}`;
        this.#pulled.get(key)?.resolve();
        this.#pulled.delete(key);
        next = await Promise.race([iterator.next(), cut.promise]);
      }
    } finally {
      this.active--;
      await iterator.return?.();
    }
  }
}

interface Held {
  sessionID?: string;
  /** Settles once the sink starts stalling on the held session's busy status. */
  readonly entered: PromiseWithResolvers<void>;
  readonly release: PromiseWithResolvers<void>;
}

/** An event log whose sink stalls on the held session's busy status until released. */
function holdingLog(): { readonly log: EventLog; readonly held: Held } {
  const held: Held = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  const log = new EventLog(async (event) => {
    if (
      event.type === LegacyEventType.SessionStatus &&
      event.properties.sessionID === held.sessionID &&
      event.properties.status.type === SessionStatusKind.Busy
    ) {
      held.entered.resolve();
      await held.release.promise;
    }
  });
  return { log, held };
}

/** Runs `action` and returns the first argument of every `console.error` call made meanwhile. */
async function errorsDuring(action: () => Promise<void>): Promise<unknown[]> {
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...data: unknown[]) => {
    logged.push(data[0]);
    original(...data);
  };
  try {
    await action();
  } finally {
    console.error = original;
  }
  return logged;
}

async function createSession(bridge: Bridge, title: string): Promise<string> {
  const created = await bridge.input.client.session.create({ body: { title } });
  assert.ok(created.data, JSON.stringify(created.error));
  return created.data.id;
}

async function promptSession(bridge: Bridge, id: string, text: string): Promise<void> {
  const reply = await bridge.input.client.session.prompt({
    path: { id },
    body: { parts: [{ type: ContentKind.Text, text }] },
  });
  assert.ok(reply.data, JSON.stringify(reply.error));
}

/** A `todowrite` list the bridge cannot store must not cost a coalesced turn its idle. */
export async function verifyTodoFailure(
  context: Plugin.Context,
  bridge: Bridge,
): Promise<"passed"> {
  const stream = new FlakyStream(context);
  const failing: Plugin.Context = {
    ...context,
    event: { subscribe: stream.subscribe },
    session: {
      ...context.session,
      async update() {
        throw new Error("fixture todo store failure");
      },
    },
  };
  const { log, held } = holdingLog();
  const events = clientEvents(failing, new SessionRetries(), new ClientSessionState());
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => events.stop());
  await events.start(log.sink);
  const id = await createSession(bridge, "stability todo failure");
  await log.until(
    (event) => event.type === LegacyEventType.SessionCreated && event.properties.info.id === id,
    "the todo failure session's creation",
  );
  held.sessionID = id;
  const queued = stream.pulled(id, SessionEventType.ExecutionSucceeded);
  await promptSession(bridge, id, "CLIENT_TODO");
  await queued;
  held.release.resolve();
  await log.until(idleOf(id), "idle after a todo list the bridge could not store");
  const types = settledOrder(log.since(0, id));
  assert.equal(types.filter((type) => type === LegacyEventType.SessionIdle).length, 1);
  assert.ok(!types.includes(LegacyEventType.TodoUpdated), JSON.stringify(types));
  return "passed";
}

export async function verifyStability(
  context: Plugin.Context,
  bridge: Bridge,
): Promise<Readonly<Record<"startup" | "recovery" | "coalescing", "passed">>> {
  const stream = new FlakyStream(context);
  const fetches = new Map<string, number>();
  let seedFailures = 1;
  const flaky: Plugin.Context = {
    ...context,
    event: { subscribe: stream.subscribe },
    session: {
      ...context.session,
      async list(input, options) {
        if (seedFailures-- > 0) throw new Error("fixture seed failure");
        return await context.session.list(input, options);
      },
      async context(input, options) {
        fetches.set(input.sessionID, (fetches.get(input.sessionID) ?? 0) + 1);
        return await context.session.context(input, options);
      },
    },
  };
  const { log, held } = holdingLog();
  const retries = new SessionRetries();
  const state = new ClientSessionState();
  const events = clientEvents(flaky, retries, state);
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => events.stop());

  await assert.rejects(events.start(log.sink), /fixture seed failure/);
  await events.start(log.sink);

  const create = (title: string): Promise<string> => createSession(bridge, title);
  const prompt = (id: string): Promise<void> => promptSession(bridge, id, "CLIENT_STABILITY");
  const idles = (mark: number, id: string): number =>
    log.since(mark, id).filter((event) => event.type === LegacyEventType.SessionIdle).length;
  const live = async (id: string, label: string): Promise<void> => {
    const mark = log.mark();
    await prompt(id);
    await log.until(idleOf(id), label, mark);
    settledOrder(log.since(mark, id));
    assert.equal(idles(mark, id), 1, label);
  };

  const ended = await create("stability ended");
  const doomed = await create("stability deleted");
  await log.until(
    (event) => event.type === LegacyEventType.SessionCreated && event.properties.info.id === doomed,
    "the doomed session's creation",
  );
  stream.end();
  await stream.reopened();
  await live(ended, "idle after the stream ended and resubscribed");

  await remember(state, retries, doomed);
  const gap = log.mark();
  stream.down = true;
  stream.fail(new Error("fixture event stream failure"));
  const missed = await create("stability gap");
  await prompt(missed);
  assert.equal((await bridge.input.client.session.delete({ path: { id: doomed } })).data, true);
  stream.down = false;
  await stream.reopened();
  await log.until(idleOf(missed), "idle for a turn that ran while the stream was down", gap);
  await log.until(
    (event) => event.type === LegacyEventType.SessionDeleted && event.properties.info.id === doomed,
    "deletion of a session removed while the stream was down",
    gap,
  );
  assert.ok(forgotten(state, retries, doomed), "a resync kept a deleted session's state");
  const caught = log.since(gap, missed);
  const types = settledOrder(caught);
  assert.ok(
    log
      .since(gap)
      .some(
        (event) =>
          event.type === LegacyEventType.SessionCreated && event.properties.info.id === missed,
      ),
    "a session created while the stream was down was never announced",
  );
  assert.equal(idles(gap, missed), 1, JSON.stringify(types));
  assert.ok(
    caught.some(
      (event) =>
        event.type === LegacyEventType.MessageUpdated &&
        event.properties.info.role === MessageRole.Assistant,
    ),
    JSON.stringify(types),
  );
  await live(missed, "idle for a live turn after the outage");

  const busy = await create("stability coalescing");
  await log.until(
    (event) => event.type === LegacyEventType.SessionCreated && event.properties.info.id === busy,
    "the coalescing session's creation",
  );
  held.sessionID = busy;
  const before = { fetches: fetches.get(busy) ?? 0, delivered: stream.delivered.get(busy) ?? 0 };
  const coalesced = log.mark();
  const queued = stream.pulled(busy, SessionEventType.ExecutionSucceeded);
  await prompt(busy);
  await log.until(
    (event) =>
      event.type === LegacyEventType.SessionStatus &&
      event.properties.sessionID === busy &&
      event.properties.status.type === SessionStatusKind.Busy,
    "the held busy status",
    coalesced,
  );
  await queued;
  held.release.resolve();
  await log.until(idleOf(busy), "idle after a coalesced turn", coalesced);
  settledOrder(log.since(coalesced, busy));
  const delivered = (stream.delivered.get(busy) ?? 0) - before.delivered;
  const fetched = (fetches.get(busy) ?? 0) - before.fetches;
  assert.ok(delivered >= 4, `only ${delivered} native events reached the bridge`);
  assert.ok(fetched <= 2, `${fetched} snapshot fetches for ${delivered} native events`);
  return { startup: "passed", recovery: "passed", coalescing: "passed" };
}

/**
 * OpenCode publishes every location's session events on one bus, so a bridge announces only its own
 * location's sessions. The bridge here lives in another directory, where only a relocated sentinel
 * session belongs; the bus delivers in order, so the sentinel's idle and deletion arrive after
 * everything the foreign session did.
 */
export async function verifyLocationScope(
  context: Plugin.Context,
  bridge: Bridge,
): Promise<"passed"> {
  const elsewhere = Location.Info.fields.directory.make(`${context.location.directory}-elsewhere`);
  const foreign = await createSession(bridge, "location scope foreign");
  const sentinel = await createSession(bridge, "location scope sentinel");
  const relocate = (session: SessionInfo): SessionInfo =>
    session.id === sentinel ? { ...session, location: { directory: elsewhere } } : session;
  const scoped: Plugin.Context = {
    ...context,
    location: new Location.Info({ directory: elsewhere, project: context.location.project }),
    session: {
      ...context.session,
      async get(input, options) {
        return relocate(await context.session.get(input, options));
      },
      async list(input, options) {
        const page = await context.session.list(input, options);
        return { ...page, data: page.data.map(relocate) };
      },
    },
  };
  const log = new EventLog();
  const events = clientEvents(scoped, new SessionRetries(), new ClientSessionState());
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => events.stop());
  const logged = await errorsDuring(async () => {
    await events.start(log.sink);
    await promptSession(bridge, foreign, "CLIENT_STABILITY");
    await promptSession(bridge, sentinel, "CLIENT_STABILITY");
    await log.until(idleOf(sentinel), "the sentinel's idle in its own location");
    await context.session.remove({ sessionID: foreign });
    await context.session.remove({ sessionID: sentinel });
    await log.until(
      (event) =>
        event.type === LegacyEventType.SessionDeleted && event.properties.info.id === sentinel,
      "the sentinel's deletion",
    );
  });
  assert.deepEqual(
    log.since(0, foreign).map((event) => event.type),
    [],
  );
  const idles = log
    .since(0, sentinel)
    .filter((event) => event.type === LegacyEventType.SessionIdle);
  assert.equal(idles.length, 1);
  assert.deepEqual(logged, []);
  return "passed";
}

const routesKey = Symbol.for("omsago.bridge.routes.v1");

/** Settles at the next directory lookup in the bridge registry, as a closed bridge makes one. */
function nextLookup(): Promise<void> {
  const registry: unknown = Reflect.get(globalThis, routesKey);
  assert.ok(registry instanceof Map);
  const looked = Promise.withResolvers<void>();
  Reflect.set(registry, "get", (key: unknown): unknown => {
    Reflect.deleteProperty(registry, "get");
    looked.resolve();
    return registry.get(key);
  });
  return looked.promise;
}

const bridgeError =
  (status: number) =>
  (error: unknown): boolean =>
    error instanceof BridgeError && error.status === status;

/** Stopping is bounded and final even while a handler or the seed listing never settles. */
export async function verifyStop(
  context: Plugin.Context,
  bridge: Bridge,
): Promise<
  Readonly<
    Record<
      "stalledHandler" | "stalledSeed" | "stoppedDelivery" | "closedTransport" | "successor",
      "passed"
    >
  >
> {
  await using cleanup = new AsyncDisposableStack();

  const stall = Promise.withResolvers<void>();
  cleanup.defer(() => {
    stall.resolve();
  });
  const entered = Promise.withResolvers<void>();
  let handled = 0;
  const stalled = clientEvents(context, new SessionRetries(), new ClientSessionState(), {
    stopMs: 50,
  });
  cleanup.defer(() => stalled.stop());
  await stalled.start({
    async event() {
      handled++;
      entered.resolve();
      await stall.promise;
    },
  });
  await createSession(bridge, "stop with a stalled handler");
  await entered.promise;
  const logged = await errorsDuring(() => stalled.stop());
  assert.equal(handled, 1);
  assert.equal(
    logged.filter(
      (message) => typeof message === "string" && message.startsWith("Client bridge stopped"),
    ).length,
    1,
    JSON.stringify(logged),
  );

  const listing = Promise.withResolvers<void>();
  cleanup.defer(() => {
    listing.resolve();
  });
  let listed: AbortSignal | undefined;
  const seedStream = new FlakyStream(context);
  const unlisted: Plugin.Context = {
    ...context,
    event: { subscribe: seedStream.subscribe },
    session: {
      ...context.session,
      async list(input, options) {
        listed = options?.signal;
        await listing.promise;
        return await context.session.list(input, options);
      },
    },
  };
  const seedless = clientEvents(unlisted, new SessionRetries(), new ClientSessionState(), {
    startMs: 50,
  });
  cleanup.defer(() => seedless.stop());
  await assert.rejects(seedless.start(new EventLog().sink), bridgeError(504));
  assert.equal(listed?.aborted, true);
  assert.equal(seedStream.active, 0);

  const stream = new FlakyStream(context);
  const flaky: Plugin.Context = { ...context, event: { subscribe: stream.subscribe } };
  const { log, held } = holdingLog();
  const delivering = clientEvents(flaky, new SessionRetries(), new ClientSessionState(), {
    stopMs: 60_000,
  });
  cleanup.defer(() => delivering.stop());
  cleanup.defer(() => {
    held.release.resolve();
  });
  await delivering.start(log.sink);
  const id = await createSession(bridge, "stop during delivery");
  await log.until(
    (event) => event.type === LegacyEventType.SessionCreated && event.properties.info.id === id,
    "the stopped session's creation",
  );
  held.sessionID = id;
  const queued = stream.pulled(id, SessionEventType.ExecutionSucceeded);
  await promptSession(bridge, id, "CLIENT_STABILITY");
  await held.entered.promise;
  await queued;
  const mark = log.mark();
  const stopping = delivering.stop();
  held.release.resolve();
  await stopping;
  assert.deepEqual(
    log.since(mark).map((event) => event.type),
    [],
  );

  const closing = createClientBridge(context, { emit: () => Promise.resolve() });
  cleanup.defer(() => closing.close());
  const loopback = new URL("/session", closing.input.serverUrl);
  const unavailable = await fetch(loopback);
  assert.equal(unavailable.status, 404);
  assert.equal(
    z.object({ name: z.string() }).parse(await unavailable.json()).name,
    ErrorName.NotFound,
  );
  await closing.start(new EventLog().sink);
  await closing.stop();
  const sessions = await closing.input.client.session.list();
  assert.ok(sessions.data, JSON.stringify(sessions.error));
  await closing.close();
  await closing.close();
  // The fixture's own bridge for this directory is still open, so it answers for the closed one.
  const forwarded = await closing.input.client.session.list();
  assert.ok(forwarded.data, JSON.stringify(forwarded.error));
  await assert.rejects(fetch(loopback));
  const unstarted = createClientBridge(context, { emit: () => Promise.resolve() });
  await unstarted.close();
  await assert.rejects(unstarted.start(new EventLog().sink), bridgeError(409));
  return {
    stalledHandler: "passed",
    stalledSeed: "passed",
    stoppedDelivery: "passed",
    closedTransport: "passed",
    successor: await verifySuccessor(context),
  };
}

/**
 * A closed bridge waits for a reloaded one in its directory, gives up with 503 when none opens, and
 * stops waiting when its caller aborts. The registry forgets a directory once its bridges close.
 */
async function verifySuccessor(context: Plugin.Context): Promise<"passed"> {
  const directory = Location.Info.fields.directory.make(
    `${context.location.directory}/omsago-successor-${crypto.randomUUID()}`,
  );
  const located: Plugin.Context = {
    ...context,
    location: new Location.Info({ directory, project: context.location.project }),
  };
  const toasts = { emit: () => Promise.resolve() };
  await using cleanup = new AsyncDisposableStack();
  await mkdir(directory);
  cleanup.defer(() => rm(directory, { recursive: true, force: true }));

  const late = createClientBridge(located, toasts, { successorMs: 10_000 });
  await late.close();
  const lookup = nextLookup();
  const pending = late.input.client.app.agents();
  await Promise.race([lookup, pending]);
  const reloaded = createClientBridge(located, toasts);
  cleanup.defer(() => reloaded.close());
  const agents = await pending;
  assert.ok(agents.data, JSON.stringify(agents.error));
  await reloaded.close();

  const unanswered = createClientBridge(located, toasts, { successorMs: 50 });
  await unanswered.close();
  await assert.rejects(unanswered.input.client.app.agents(), bridgeError(503));

  const waiting = createClientBridge(located, toasts, { successorMs: 60_000 });
  await waiting.close();
  const controller = new AbortController();
  const reason = new Error("fixture abort");
  const waited = nextLookup();
  const abandoned = waiting.input.client.app.agents({ signal: controller.signal });
  await Promise.race([waited, abandoned]);
  controller.abort(reason);
  await assert.rejects(abandoned, (error) => error === reason);

  const registry: unknown = Reflect.get(globalThis, routesKey);
  assert.ok(registry instanceof Map);
  assert.equal(registry.has(directory), false);
  return "passed";
}

/**
 * Deleting a session by a native event or the legacy route clears its per-session state, and a
 * stopped bridge reports no retry that no event will ever clear.
 */
export async function verifyLifecycle(
  context: Plugin.Context,
  bridge: Bridge,
  model: ClientModel,
): Promise<Readonly<Record<"deletedByEvent" | "deletedByRoute" | "retryAfterStop", "passed">>> {
  await using cleanup = new AsyncDisposableStack();

  const retries = new SessionRetries();
  const state = new ClientSessionState();
  const events = clientEvents(context, retries, state);
  cleanup.defer(() => events.stop());
  const log = new EventLog();
  await events.start(log.sink);
  const removed = await createSession(bridge, "deleted by event");
  await log.until(
    (event) =>
      event.type === LegacyEventType.SessionCreated && event.properties.info.id === removed,
    "the creation of a session deleted by event",
  );
  await remember(state, retries, removed);
  await context.session.remove({ sessionID: removed });
  await log.until(
    (event) =>
      event.type === LegacyEventType.SessionDeleted && event.properties.info.id === removed,
    "the deletion event",
  );
  assert.ok(forgotten(state, retries, removed), "a session.deleted event kept session state");

  const routeRetries = new SessionRetries();
  const routeState = new ClientSessionState();
  const routes = sessionRoutes(context, routeState, routeRetries);
  const routed = await createSession(bridge, "deleted by route");
  await remember(routeState, routeRetries, routed);
  const response = await routes(
    new Request(`http://omsago.invalid/session/${routed}`, { method: "DELETE" }),
    ["session", routed],
  );
  assert.equal(await response.json(), true);
  assert.ok(forgotten(routeState, routeRetries, routed), "DELETE /session/:id kept session state");
  const deleted = await createSession(bridge, "deleted through the bridge");
  await bridge.sessionState.variant(deleted, () => Promise.resolve([]));
  assert.equal((await bridge.input.client.session.delete({ path: { id: deleted } })).data, true);
  assert.equal(bridge.sessionState.take(deleted), undefined);

  const stopping = createClientBridge(context, { emit: () => Promise.resolve() });
  cleanup.defer(() => stopping.close());
  const stoppingLog = new EventLog();
  await stopping.start(stoppingLog.sink);
  const stalled = await createSession(stopping, "retry after stop");
  model.stallRetries(stalled);
  const status = async () => (await stopping.input.client.session.status()).data?.[stalled];
  const scheduled = stoppingLog.mark();
  const queued = await stopping.input.client.session.promptAsync({
    path: { id: stalled },
    body: { parts: [{ type: ContentKind.Text, text: "CLIENT_STALLED_RETRY" }] },
  });
  assert.equal(queued.response.status, 204);
  await stoppingLog.until(
    (event) =>
      event.type === LegacyEventType.SessionStatus &&
      event.properties.sessionID === stalled &&
      event.properties.status.type === SessionStatusKind.Retry,
    "a stalled provider retry",
    scheduled,
  );
  assert.equal((await status())?.type, SessionStatusKind.Retry);
  await stopping.stop();
  assert.deepEqual(await status(), { type: SessionStatusKind.Busy });
  assert.equal((await context.session.interrupt({ sessionID: stalled })).interrupted, true);
  await context.session.wait({ sessionID: stalled });
  assert.deepEqual(await status(), { type: SessionStatusKind.Idle });
  const idle = new SessionRetries();
  idle.set(stalled, pendingRetry);
  assert.deepEqual(idle.status(await context.session.get({ sessionID: stalled })), {
    type: SessionStatusKind.Idle,
  });
  await stopping.close();
  assert.equal(
    (await bridge.input.client.session.status()).data?.[stalled]?.type,
    SessionStatusKind.Idle,
  );
  return { deletedByEvent: "passed", deletedByRoute: "passed", retryAfterStop: "passed" };
}
