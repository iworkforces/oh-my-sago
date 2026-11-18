import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { clientEvents } from "../../../src/client/events.js";
import type { createClientBridge } from "../../../src/client/index.js";
import { SessionRetries } from "../../../src/client/sessions.js";
import {
  ContentKind,
  LegacyEventType,
  MessageRole,
  SessionEventType,
  SessionStatusKind,
} from "../../../src/enums.js";
import { EventLog, idleOf } from "./events.js";
import { settledOrder } from "./turns.js";

type Bridge = ReturnType<typeof createClientBridge>;
type Outcome = { readonly done: true; readonly value: undefined };
const sessionData = z.object({ sessionID: z.string() });

/** A native event stream the fixture can end, fail or hold down, counting what it delivers. */
class FlakyStream {
  down = false;
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
      await iterator.return?.();
    }
  }
}

/** An event log whose sink stalls on the held session's busy status until released. */
function holdingLog(): {
  readonly log: EventLog;
  readonly held: { sessionID?: string; readonly release: PromiseWithResolvers<void> };
} {
  const held: { sessionID?: string; readonly release: PromiseWithResolvers<void> } = {
    release: Promise.withResolvers<void>(),
  };
  const log = new EventLog(async (event) => {
    if (
      event.type === LegacyEventType.SessionStatus &&
      event.properties.sessionID === held.sessionID &&
      event.properties.status.type === SessionStatusKind.Busy
    )
      await held.release.promise;
  });
  return { log, held };
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
  const events = clientEvents(failing, new SessionRetries());
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => events.dispose());
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
  const events = clientEvents(flaky, new SessionRetries());
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => events.dispose());

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
