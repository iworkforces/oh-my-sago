import type { LegacyEvent, LegacyEventSink } from "../../../src/client/events.js";
import { LegacyEventType } from "../../../src/enums.js";

type Match = (event: LegacyEvent) => boolean;

export function sessionOf(event: LegacyEvent): string | undefined {
  if (event.type === LegacyEventType.MessageUpdated) return event.properties.info.sessionID;
  if (event.type === LegacyEventType.MessagePartUpdated) return event.properties.part.sessionID;
  return "sessionID" in event.properties && typeof event.properties.sessionID === "string"
    ? event.properties.sessionID
    : undefined;
}

export const idleOf =
  (sessionID: string): Match =>
  (event) =>
    event.type === LegacyEventType.SessionIdle && event.properties.sessionID === sessionID;

export const compactionOf =
  (
    type:
      | typeof LegacyEventType.SessionCompactionStarted
      | typeof LegacyEventType.SessionCompactionFailed,
    sessionID: string,
  ): Match =>
  (event) =>
    event.type === type && event.properties.sessionID === sessionID;

export class EventLog {
  readonly #events: LegacyEvent[] = [];
  readonly #waiters = new Set<{ readonly match: Match; readonly resolve: () => void }>();
  readonly sink: LegacyEventSink;

  constructor(observe?: (event: LegacyEvent) => Promise<void>) {
    this.sink = {
      event: async ({ event }) => {
        this.#events.push(event);
        await observe?.(event);
        for (const waiter of this.#waiters)
          if (waiter.match(event)) {
            this.#waiters.delete(waiter);
            waiter.resolve();
          }
      },
    };
  }

  mark(): number {
    return this.#events.length;
  }

  since(mark: number, sessionID?: string): LegacyEvent[] {
    return this.#events
      .slice(mark)
      .filter((event) => sessionID === undefined || sessionOf(event) === sessionID);
  }

  async until(match: Match, label: string, mark = 0): Promise<void> {
    if (this.#events.slice(mark).some(match)) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      this.#waiters.delete(waiter);
      reject(new Error(`Timed out waiting for ${label}`));
    }, 20_000);
    const waiter = {
      match,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    this.#waiters.add(waiter);
    await promise;
  }
}
