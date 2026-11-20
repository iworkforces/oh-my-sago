import { setTimeout as sleep } from "node:timers/promises";
import type { Plugin } from "@opencode/plugin";
import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { SelectedEvent } from "@opencode/client/promise/api";
import type { Event, EventTodoUpdated, SessionMessagesResponse } from "@opencode-ai/sdk";
import type { Todo } from "@opencode-ai/sdk/v2";
import { ErrorName, LegacyEventType, SessionEventType, SessionStatusKind } from "../enums.js";
import { BridgeError, assertNever } from "./errors.js";
import { legacyError, legacyMessages } from "./messages.js";
import {
  type BackgroundWaits,
  type SessionRetries,
  isBusy,
  legacySession,
  listSessions,
} from "./sessions.js";
import { abortedBy, raceAbort } from "./signal.js";
import type { ClientSessionState } from "./state.js";
import { recordTodos } from "./todos.js";

const types = [
  SessionEventType.Created,
  SessionEventType.Deleted,
  SessionEventType.Renamed,
  SessionEventType.Moved,
  SessionEventType.AgentSelected,
  SessionEventType.ModelSelected,
  SessionEventType.MetadataUpdated,
  SessionEventType.Permissions,
  SessionEventType.Archived,
  SessionEventType.Unarchived,
  SessionEventType.ExecutionStarted,
  SessionEventType.ExecutionSucceeded,
  SessionEventType.ExecutionFailed,
  SessionEventType.ExecutionInterrupted,
  SessionEventType.InboxDelivered,
  SessionEventType.Synthetic,
  SessionEventType.StepStarted,
  SessionEventType.StepEnded,
  SessionEventType.StepFailed,
  SessionEventType.TextDelta,
  SessionEventType.TextEnded,
  SessionEventType.ReasoningDelta,
  SessionEventType.ReasoningEnded,
  SessionEventType.ToolCalled,
  SessionEventType.ToolProgress,
  SessionEventType.ToolSuccess,
  SessionEventType.ToolFailed,
  SessionEventType.RetryScheduled,
  SessionEventType.CompactionStarted,
  SessionEventType.CompactionEnded,
  SessionEventType.CompactionFailed,
] as const;

type NativeEvent = SelectedEvent<OpenCodeEvent, (typeof types)[number]>;

const settles: ReadonlySet<NativeEvent["type"]> = new Set([
  SessionEventType.ExecutionSucceeded,
  SessionEventType.ExecutionFailed,
  SessionEventType.ExecutionInterrupted,
]);

/** High-frequency events whose only effect is a fresh message diff; back-to-back ones collapse. */
const passive: ReadonlySet<NativeEvent["type"]> = new Set([
  SessionEventType.TextDelta,
  SessionEventType.ReasoningDelta,
  SessionEventType.ToolProgress,
]);

/** Delay before resubscribing after the native stream fails or ends, doubled per failed attempt. */
const reconnectDelay = { initialMs: 100, maxMs: 5_000 } as const;

/** How long `start` waits for the seed snapshot and `stop` waits for an event handler in flight. */
export interface EventBounds {
  readonly startMs: number;
  readonly stopMs: number;
}

const defaultBounds: EventBounds = { startMs: 15_000, stopMs: 5_000 };

interface Connection {
  readonly controller: AbortController;
  /** Whether a resync has caught up on the gap before this connection; only then does backoff reset. */
  synced: boolean;
}

/** `seed` loads the initial snapshots silently; a resync announces what a gap before `connection` hid. */
const seed = Symbol("seed");
type Resync = { readonly connection: Connection };
type Queued = NativeEvent | typeof seed | Resync;

/**
 * v1 todos carry no `id`; OmO keys them by content and priority. The legacy SDK defines no
 * compaction start or failure, but OmO's compaction registry reads both, by session only.
 */
export type LegacyEvent =
  | Exclude<Event, EventTodoUpdated>
  | { type: typeof LegacyEventType.TodoUpdated; properties: { sessionID: string; todos: Todo[] } }
  | {
      type:
        | typeof LegacyEventType.SessionCompactionStarted
        | typeof LegacyEventType.SessionCompactionFailed;
      properties: { sessionID: string };
    };

export interface LegacyEventSink {
  // Method syntax keeps OmO's `Hooks`, typed against the id-carrying todo, assignable here.
  event?(input: { event: LegacyEvent }): Promise<void>;
}

export interface ClientEvents {
  start(hooks: LegacyEventSink): Promise<void>;
  /** Starts no handler from now on and waits up to `stopMs` for the one in flight; idempotent. */
  stop(): Promise<void>;
}

export function clientEvents(
  context: Plugin.Context,
  retries: SessionRetries,
  waits: BackgroundWaits,
  state: ClientSessionState,
  bounds: Partial<EventBounds> = {},
): ClientEvents {
  const { startMs, stopMs } = { ...defaultBounds, ...bounds };
  const controller = new AbortController();
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, SessionMessagesResponse>();
  /** The latest `time.idle` per session that OmO has been told about, so a resync can spot missed turns. */
  const settled = new Map<string, number | undefined>();
  /** Idle times a resync announced; the stream's own settle event for that turn is then a duplicate. */
  const resynced = new Map<string, number>();
  /**
   * OpenCode starts one plugin instance, and so one OmO runtime, per location, but publishes every
   * location's session events on one bus. A bridge announces only its own location's sessions, or
   * each runtime would answer every turn: N idles, N todo-continuation countdowns and N prompts.
   */
  const owns = (session: SessionInfo): boolean =>
    session.location.directory === context.location.directory;
  /** Sessions of other locations, whose events need no snapshot unless a move brings them here. */
  const foreign = new Set<string>();
  let running: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const forget = (sessionID: string): void => {
    sessions.delete(sessionID);
    messages.delete(sessionID);
    settled.delete(sessionID);
    resynced.delete(sessionID);
    foreign.delete(sessionID);
    retries.clear(sessionID);
    waits.delete(sessionID);
    state.delete(sessionID);
  };
  /** Stops serving a session that belongs to another location, forgetting it if it moved away. */
  const disown = (sessionID: string): void => {
    if (sessions.has(sessionID)) forget(sessionID);
    foreign.add(sessionID);
  };
  const halt = async (): Promise<void> => {
    controller.abort();
    if (running === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(true);
      }, stopMs);
    });
    try {
      // Only this wait is bounded: racing each handler would let the next event overtake it.
      if (await Promise.race([running.then(() => false), expired]))
        console.error(`Client bridge stopped while an event handler ran past ${stopMs}ms`);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async start(hooks: LegacyEventSink): Promise<void> {
      if (stopping !== undefined) throw new BridgeError(409, "The client bridge is stopped");
      if (running !== undefined)
        throw new BridgeError(409, "The client bridge event subscription already started");
      // OpenCode runs this just before the session's `session.execution.succeeded`.
      const idleHook = await context.session.hook("experimental.idle", (event) => {
        waits.record(event);
      });
      const run = new AbortController();
      const signal = AbortSignal.any([controller.signal, run.signal]);
      const options = { signal };
      const ready = Promise.withResolvers<void>();
      const stopped = (error: unknown): boolean => abortedBy(signal, error);
      const emit = async (event: LegacyEvent): Promise<void> => {
        // Once stopped, no handler starts: the rest of a batch, a resync or the seed unwinds here.
        signal.throwIfAborted();
        try {
          await hooks.event?.({ event });
        } catch (error) {
          if (stopped(error)) throw error;
          console.error("Client bridge event handler failed", { type: event.type, error });
        }
      };
      const status = (
        sessionID: string,
        type: typeof SessionStatusKind.Busy | typeof SessionStatusKind.Idle,
      ): LegacyEvent => ({
        type: LegacyEventType.SessionStatus,
        properties: { sessionID, status: { type } },
      });
      const emitMessages = async (
        session: SessionInfo,
        records: readonly SessionMessageInfo[],
      ): Promise<void> => {
        const current = legacyMessages(session, records);
        const previous = messages.get(session.id) ?? [];
        for (const message of current) {
          const old = previous.find((entry) => entry.info.id === message.info.id);
          if (JSON.stringify(old?.info) !== JSON.stringify(message.info))
            await emit({
              type: LegacyEventType.MessageUpdated,
              properties: { info: message.info },
            });
          for (const part of message.parts) {
            const prior = old?.parts.find((entry) => entry.id === part.id);
            if (JSON.stringify(prior) !== JSON.stringify(part))
              await emit({ type: LegacyEventType.MessagePartUpdated, properties: { part } });
          }
        }
        messages.set(session.id, current);
      };
      const deleted = async (sessionID: string): Promise<void> => {
        const session = sessions.get(sessionID);
        forget(sessionID);
        // Only another location's sessions go unobserved, and their deletion is not ours to announce.
        if (session === undefined) return;
        await emit({
          type: LegacyEventType.SessionDeleted,
          properties: { info: legacySession(session, context.app.version) },
        });
      };

      const queue: Queued[] = [];
      let wake: (() => void) | undefined;
      let current: Connection | undefined;
      let failures = 0;
      const enqueue = (item: Queued): void => {
        const last = queue.at(-1);
        if (
          typeof item === "object" &&
          "type" in item &&
          passive.has(item.type) &&
          typeof last === "object" &&
          "type" in last &&
          passive.has(last.type) &&
          last.data.sessionID === item.data.sessionID
        )
          queue[queue.length - 1] = item;
        else queue.push(item);
        wake?.();
      };
      signal.addEventListener("abort", () => wake?.(), { once: true });

      /**
       * Delivers a batch in stream order, fetching one snapshot per session. Message updates are
       * diffed once per session, and settling events (`session.idle`, `session.compacted`) wait
       * for that diff unless a later lifecycle event, from any session, forces them out first.
       */
      const deliver = async (events: readonly NativeEvent[]): Promise<void> => {
        const snapshots = new Map<
          string,
          { session: SessionInfo; records: SessionMessageInfo[]; diffed: boolean }
        >();
        const groups = Map.groupBy(events, (event) => event.data.sessionID);
        await Promise.all(
          Array.from(groups, async ([sessionID, group]) => {
            if (group.some((event) => event.type === SessionEventType.Deleted)) return;
            if (
              foreign.has(sessionID) &&
              !group.some((event) => event.type === SessionEventType.Moved)
            )
              return;
            const settling = group.some((event) => settles.has(event.type));
            if (settling) retries.clear(sessionID);
            try {
              const session = await raceAbort(signal, context.session.get({ sessionID }, options));
              if (!owns(session)) {
                disown(sessionID);
                return;
              }
              foreign.delete(sessionID);
              const records = await raceAbort(
                signal,
                context.session.context({ sessionID }, options),
              );
              sessions.set(sessionID, session);
              snapshots.set(sessionID, { session, records, diffed: false });
            } catch (error) {
              if (stopped(error)) throw error;
              console.error("Client bridge skipped events it could not snapshot", {
                sessionID,
                types: group.map((event) => event.type),
                error,
              });
              // The `settled` record still lags, so a resync re-announces the missed idle.
              if (settling && current !== undefined) enqueue({ connection: current });
            }
          }),
        );
        const pending: { readonly sessionID: string; readonly event: LegacyEvent }[] = [];
        const diff = async (sessionID: string): Promise<void> => {
          const snapshot = snapshots.get(sessionID);
          if (snapshot === undefined || snapshot.diffed) return;
          snapshot.diffed = true;
          try {
            await emitMessages(snapshot.session, snapshot.records);
          } catch (error) {
            if (stopped(error)) throw error;
            console.error("Client bridge could not diff session messages", { sessionID, error });
          }
        };
        const flush = async (): Promise<void> => {
          for (const { sessionID, event } of pending.splice(0)) {
            await diff(sessionID);
            await emit(event);
          }
        };
        const now = async (legacy: LegacyEvent): Promise<void> => {
          await flush();
          await emit(legacy);
        };
        for (const event of events) {
          const { sessionID } = event.data;
          try {
            if (event.type === SessionEventType.Deleted) {
              await flush();
              await deleted(sessionID);
              continue;
            }
            const snapshot = snapshots.get(sessionID);
            if (snapshot === undefined) continue;
            const { session, records } = snapshot;
            const settle = async (error?: LegacyEvent): Promise<void> => {
              retries.clear(sessionID);
              const announced = resynced.get(sessionID);
              resynced.delete(sessionID);
              if (error !== undefined) await now(error);
              if (announced !== undefined && announced === session.time.idle) return;
              await now(status(sessionID, SessionStatusKind.Idle));
              pending.push({
                sessionID,
                event: { type: LegacyEventType.SessionIdle, properties: { sessionID } },
              });
              settled.set(sessionID, session.time.idle);
            };
            switch (event.type) {
              case SessionEventType.Created:
                await now({
                  type: LegacyEventType.SessionCreated,
                  properties: { info: legacySession(session, context.app.version) },
                });
                break;
              case SessionEventType.Renamed:
              case SessionEventType.Moved:
              case SessionEventType.AgentSelected:
              case SessionEventType.ModelSelected:
              case SessionEventType.MetadataUpdated:
              case SessionEventType.Permissions:
              case SessionEventType.Archived:
              case SessionEventType.Unarchived:
                await now({
                  type: LegacyEventType.SessionUpdated,
                  properties: { info: legacySession(session, context.app.version) },
                });
                break;
              case SessionEventType.ExecutionStarted:
                resynced.delete(sessionID);
                await now(status(sessionID, SessionStatusKind.Busy));
                break;
              case SessionEventType.ExecutionFailed:
                waits.delete(sessionID);
                await settle({
                  type: LegacyEventType.SessionError,
                  properties: { sessionID, error: legacyError(event.data.error) },
                });
                break;
              case SessionEventType.ExecutionInterrupted:
                waits.delete(sessionID);
                await settle({
                  type: LegacyEventType.SessionError,
                  properties: {
                    sessionID,
                    error: { name: ErrorName.Aborted, data: { message: event.data.reason } },
                  },
                });
                break;
              case SessionEventType.ExecutionSucceeded:
                if (!waits.has(sessionID)) await settle();
                break;
              case SessionEventType.RetryScheduled: {
                const retry = {
                  type: SessionStatusKind.Retry,
                  attempt: event.data.attempt,
                  message: event.data.error.message,
                  next: event.data.at,
                };
                retries.set(sessionID, retry);
                await now({
                  type: LegacyEventType.SessionStatus,
                  properties: { sessionID, status: retry },
                });
                break;
              }
              case SessionEventType.StepStarted:
                if (retries.clear(sessionID)) await now(status(sessionID, SessionStatusKind.Busy));
                break;
              case SessionEventType.ToolSuccess: {
                const todos = await raceAbort(
                  signal,
                  recordTodos(context, sessionID, event.data, records, options),
                );
                if (todos !== undefined)
                  await now({
                    type: LegacyEventType.TodoUpdated,
                    properties: { sessionID, todos },
                  });
                break;
              }
              case SessionEventType.CompactionStarted:
                await now({
                  type: LegacyEventType.SessionCompactionStarted,
                  properties: { sessionID },
                });
                break;
              case SessionEventType.CompactionEnded:
                pending.push({
                  sessionID,
                  event: { type: LegacyEventType.SessionCompacted, properties: { sessionID } },
                });
                break;
              case SessionEventType.CompactionFailed:
                pending.push({
                  sessionID,
                  event: {
                    type: LegacyEventType.SessionCompactionFailed,
                    properties: { sessionID },
                  },
                });
                break;
              case SessionEventType.InboxDelivered:
              case SessionEventType.Synthetic:
              case SessionEventType.StepEnded:
              case SessionEventType.StepFailed:
              case SessionEventType.TextDelta:
              case SessionEventType.TextEnded:
              case SessionEventType.ReasoningDelta:
              case SessionEventType.ReasoningEnded:
              case SessionEventType.ToolCalled:
              case SessionEventType.ToolProgress:
              case SessionEventType.ToolFailed:
                break;
              default:
                assertNever(event);
            }
          } catch (error) {
            if (stopped(error)) throw error;
            console.error("Client bridge skipped an event it could not deliver", {
              type: event.type,
              sessionID,
              error,
            });
          }
        }
        await flush();
        for (const sessionID of groups.keys()) await diff(sessionID);
      };

      /** Announces what changed in a session while no stream was delivering its events. */
      const catchUp = async (session: SessionInfo): Promise<void> => {
        const known = sessions.get(session.id);
        const idle = session.time.idle;
        const finished =
          !isBusy(session) &&
          idle !== undefined &&
          idle !== settled.get(session.id) &&
          !waits.has(session.id);
        if (!isBusy(session)) retries.clear(session.id);
        if (!finished && JSON.stringify(known) === JSON.stringify(session)) return;
        const records = await raceAbort(
          signal,
          context.session.context({ sessionID: session.id }, options),
        );
        sessions.set(session.id, session);
        const info = legacySession(session, context.app.version);
        if (known === undefined)
          await emit({ type: LegacyEventType.SessionCreated, properties: { info } });
        else if (JSON.stringify(legacySession(known, context.app.version)) !== JSON.stringify(info))
          await emit({ type: LegacyEventType.SessionUpdated, properties: { info } });
        if (isBusy(session) && (known === undefined || !isBusy(known)))
          await emit(status(session.id, SessionStatusKind.Busy));
        await emitMessages(session, records);
        if (!finished) return;
        settled.set(session.id, idle);
        resynced.set(session.id, idle);
        await emit(status(session.id, SessionStatusKind.Idle));
        await emit({ type: LegacyEventType.SessionIdle, properties: { sessionID: session.id } });
      };

      const reconcile = async (announce: boolean): Promise<void> => {
        const listed = await raceAbort(
          signal,
          listSessions(context, new Request("http://omsago.invalid/session", { signal })),
        );
        const fresh = new Map<string, SessionInfo>();
        for (const session of listed) {
          if (owns(session)) fresh.set(session.id, session);
          else disown(session.id);
        }
        if (!announce) {
          for (const session of fresh.values()) {
            sessions.set(session.id, session);
            settled.set(session.id, session.time.idle);
          }
          return;
        }
        for (const sessionID of [...sessions.keys()].filter((id) => !fresh.has(id))) {
          try {
            const session = await raceAbort(signal, context.session.get({ sessionID }, options));
            if (owns(session)) fresh.set(sessionID, session);
            else disown(sessionID);
          } catch (error) {
            if (!(error instanceof Error && error.name === ErrorName.SessionNotFound)) throw error;
            await deleted(sessionID);
          }
        }
        for (const session of fresh.values()) {
          try {
            await catchUp(session);
          } catch (error) {
            if (stopped(error)) throw error;
            console.error("Client bridge could not resync a session", {
              sessionID: session.id,
              error,
            });
          }
        }
      };

      const pump = async (): Promise<void> => {
        for (let attempt = 0; !signal.aborted; attempt++) {
          const connection: Connection = {
            controller: new AbortController(),
            synced: attempt === 0,
          };
          current = connection;
          const live = AbortSignal.any([signal, connection.controller.signal]);
          let iterator: AsyncIterator<NativeEvent> | undefined;
          try {
            iterator = context.event.subscribe({ types, signal: live })[Symbol.asyncIterator]();
            // The first pull opens the subscription, so the resync it queues reads state after that.
            const first = iterator.next();
            if (attempt > 0) enqueue({ connection });
            for (let next = await first; next.done !== true; next = await iterator.next()) {
              if (connection.synced) failures = 0;
              enqueue(next.value);
            }
            if (signal.aborted) return;
            console.error("Client bridge event subscription ended; resubscribing");
          } catch (error) {
            if (stopped(error)) return;
            console.error("Client bridge event subscription failed; resubscribing", error);
          } finally {
            try {
              await iterator?.return?.();
            } catch (error) {
              if (!stopped(error))
                console.error("Client bridge could not close an event subscription", error);
            }
          }
          const delay = Math.min(reconnectDelay.initialMs * 2 ** failures++, reconnectDelay.maxMs);
          try {
            await sleep(delay, undefined, { signal });
          } catch (error) {
            if (stopped(error)) return;
            throw error;
          }
        }
      };

      const work = async (): Promise<void> => {
        try {
          while (!signal.aborted) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
              continue;
            }
            const events: NativeEvent[] = [];
            for (const item of queue.splice(0)) {
              if (item === seed) {
                try {
                  await reconcile(false);
                } catch (error) {
                  ready.reject(error);
                  return;
                }
                ready.resolve();
              } else if ("connection" in item) {
                await deliver(events.splice(0));
                try {
                  await reconcile(true);
                  item.connection.synced = true;
                } catch (error) {
                  if (stopped(error)) throw error;
                  console.error("Client bridge could not resync; reconnecting", error);
                  item.connection.controller.abort(error);
                }
              } else events.push(item);
            }
            await deliver(events);
          }
        } catch (error) {
          if (!stopped(error)) throw error;
        } finally {
          ready.reject(new BridgeError(409, "The client bridge stopped before it started"));
        }
      };

      // A task that dies unexpectedly stops the other, so the bridge never runs half-deaf.
      const guard = (task: Promise<void>): Promise<void> =>
        task.catch((error: unknown) => {
          console.error("Client bridge event subscription failed", error);
          run.abort(error);
        });
      const pumping = guard(pump());
      enqueue(seed);
      running = (async () => {
        try {
          await Promise.all([pumping, guard(work())]);
        } finally {
          await idleHook.dispose();
        }
      })();
      const deadline = setTimeout(() => {
        run.abort(
          new BridgeError(504, `The client bridge did not load sessions within ${startMs}ms`),
        );
      }, startMs);
      try {
        await ready.promise;
      } catch (error) {
        run.abort();
        await running;
        running = undefined;
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    },
    stop(): Promise<void> {
      stopping ??= halt();
      return stopping;
    },
  };
}
