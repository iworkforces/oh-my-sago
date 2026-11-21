import type { Plugin } from "@opencode/plugin";
import type { SessionInfo } from "@opencode/client";
import type { SessionIdle } from "@opencode/plugin/promise/session";
import type { Session, SessionStatus } from "@opencode-ai/sdk";
import { SessionStatusKind } from "../enums.js";

export function legacySession(session: SessionInfo, version: string): Session {
  return {
    id: session.id,
    projectID: session.projectID,
    directory: session.location.directory,
    ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
    title: session.title ?? "",
    version,
    time: { created: session.time.created, updated: session.time.updated },
  };
}

export function isBusy(session: SessionInfo): boolean {
  const { busy, idle } = session.time;
  return busy !== undefined && (idle === undefined || busy > idle);
}

export type RetryStatus = Extract<SessionStatus, { type: typeof SessionStatusKind.Retry }>;

/**
 * Pending provider retries, shared by one bridge's event loop and its status route. Only a busy
 * session reports one, and none survive the bridge's event loop stopping.
 */
export class SessionRetries {
  readonly #pending = new Map<string, RetryStatus>();
  #stopped = false;

  set(sessionID: string, status: RetryStatus): void {
    if (!this.#stopped) this.#pending.set(sessionID, status);
  }
  clear(sessionID: string): boolean {
    return this.#pending.delete(sessionID);
  }
  /** Drops every pending retry and ignores later ones, since no event will ever clear them. */
  stop(): void {
    this.#stopped = true;
    this.#pending.clear();
  }
  status(session: SessionInfo): SessionStatus {
    if (!isBusy(session)) return { type: SessionStatusKind.Idle };
    return this.#pending.get(session.id) ?? { type: SessionStatusKind.Busy };
  }
}

/**
 * Sessions that went idle while work they own still runs, such as a background shell or a Code Mode
 * script that outlived its call. That work's notice wakes the session for another execution, so the
 * turn is not over: a v1 session went idle once per turn, and OmO reads that idle as the end of it,
 * completing and then deleting a background task's session. Shared by one bridge's event loop,
 * which holds such a session's idle back, and its status route, which keeps reporting it busy.
 */
export class BackgroundWaits {
  readonly #waiting = new Set<string>();

  /** Records the work OpenCode listed as the session went idle; only its own work wakes it. */
  record(idle: SessionIdle): void {
    if (idle.background.some((work) => work.sessionID === idle.sessionID))
      this.#waiting.add(idle.sessionID);
    else this.#waiting.delete(idle.sessionID);
  }
  has(sessionID: string): boolean {
    return this.#waiting.has(sessionID);
  }
  delete(sessionID: string): void {
    this.#waiting.delete(sessionID);
  }
  clear(): void {
    this.#waiting.clear();
  }
  status(session: SessionInfo, status: SessionStatus): SessionStatus {
    return status.type === SessionStatusKind.Idle && this.#waiting.has(session.id)
      ? { type: SessionStatusKind.Busy }
      : status;
  }
}

/** How long each wait of a held idle may last before the child's turn ends as usual. */
export interface IdleHoldBounds {
  /** From the child's idle until OmO claims its task by aborting the session. */
  readonly claimMs: number;
  /** From that claim until OmO's notice reaches the parent, which reports idle that long for it. */
  readonly notifyMs: number;
  /**
   * How long after a child's creation OmO ignores its idle, reading it again only then (OmO's
   * `MIN_IDLE_TIME_MS`); a younger child's claim bound runs from that point.
   */
  readonly minTaskMs: number;
}

const defaultIdleHoldBounds: IdleHoldBounds = { claimMs: 1_000, notifyMs: 3_000, minTaskMs: 5_000 };

interface Adoption {
  readonly parentID: string;
  readonly created: number;
}

interface Hold extends Adoption {
  readonly release: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  claimed: boolean;
  announced: boolean;
}

/**
 * Background children whose turn the bridge holds open at its idle, and parents it reports idle
 * for OmO's notice. OpenCode reports a child's end to its parent itself as the turn ends, waking an
 * idle parent, and OmO's own notice then finds the parent busy and waits for that turn to end, up to
 * a minute. So when a child OmO created goes idle under an idle parent, its idle reaches OmO while
 * the turn waits: OmO completes the task by aborting the child, which claims the hold, and prompts
 * the parent, which releases it. The parent then wakes to OmO's notice with OpenCode's report
 * behind it. A busy root parent of a child OmO aborts reports idle until OmO's notice reaches it,
 * which OpenCode then steers into the running turn. Each wait is bounded, after which the turn
 * ends, or the parent reports busy, as usual. Shared by one bridge's event loop, which holds and
 * announces the idle, and its routes.
 */
export class IdleHolds {
  readonly #bounds: IdleHoldBounds;
  readonly #adopted = new Map<string, Adoption>();
  readonly #holds = new Map<string, Hold>();
  /** Sessions whose idle the event loop announced before their turn ended. */
  readonly #announced = new Set<string>();
  /** Parents awaiting OmO's notice, by the timer that ends the wait. */
  readonly #notices = new Map<string, ReturnType<typeof setTimeout>>();
  #stopped = false;

  constructor(bounds: Partial<IdleHoldBounds> = {}) {
    this.#bounds = { ...defaultIdleHoldBounds, ...bounds };
  }

  /** Records a child created through this bridge; only such a child's idle is held. */
  adopt(sessionID: string, parentID: string): void {
    this.#adopted.set(sessionID, { parentID, created: Date.now() });
  }
  parentOf(sessionID: string): string | undefined {
    return this.#adopted.get(sessionID)?.parentID;
  }
  /** Holds an adopted child's turn until a release or the claim bound; never rejects. */
  park(sessionID: string): Promise<void> {
    const adoption = this.#adopted.get(sessionID);
    if (this.#stopped || adoption === undefined) return Promise.resolve();
    this.release(sessionID);
    const { promise, resolve } = Promise.withResolvers<void>();
    const hold: Hold = {
      ...adoption,
      release: resolve,
      timer: undefined,
      claimed: false,
      announced: false,
    };
    this.#holds.set(sessionID, hold);
    this.#awaitClaim(sessionID, hold);
    return promise;
  }
  parked(sessionID: string): boolean {
    return this.#holds.has(sessionID);
  }
  /**
   * Records that OmO was told of the held idle, which restarts an unclaimed hold's bound. Returns
   * whether an earlier announced idle of the turn ran on unseen, so the session is busy first.
   */
  announce(sessionID: string): boolean {
    const hold = this.#holds.get(sessionID);
    if (hold === undefined) return false;
    const ranOn = this.#announced.has(sessionID);
    hold.announced = true;
    this.#announced.add(sessionID);
    if (!hold.claimed) this.#awaitClaim(sessionID, hold);
    return ranOn;
  }
  /** Claims a held session, which then waits for its parent's notice; whether it was held. */
  claim(sessionID: string): boolean {
    const hold = this.#holds.get(sessionID);
    if (hold === undefined) return false;
    if (!hold.claimed) {
      hold.claimed = true;
      this.#wait(sessionID, hold, this.#bounds.notifyMs);
    }
    return true;
  }
  /** Reports the parent idle until OmO's notice reaches it or the notice bound passes. */
  notice(parentID: string): void {
    if (this.#stopped) return;
    clearTimeout(this.#notices.get(parentID));
    const timer = setTimeout(() => {
      this.#notices.delete(parentID);
    }, this.#bounds.notifyMs);
    timer.unref();
    this.#notices.set(parentID, timer);
  }
  /**
   * Ends the notice wait of a session a prompt reached and releases the claimed children it
   * notifies, then the session's own hold, whose turn runs on with the prompt.
   */
  prompted(sessionID: string): void {
    clearTimeout(this.#notices.get(sessionID));
    this.#notices.delete(sessionID);
    for (const [childID, hold] of this.#holds)
      if (hold.parentID === sessionID && hold.claimed) this.release(childID);
    this.release(sessionID);
  }
  /**
   * Whether a step started after an announced idle, outside the hold that announced it, so the
   * session is busy again. A later hold of the same turn may already be parked by then.
   */
  ranOn(sessionID: string): boolean {
    return this.#holds.get(sessionID)?.announced !== true && this.#announced.delete(sessionID);
  }
  /** Ends the session's hold with its turn; whether its idle was already announced. */
  takeAnnounced(sessionID: string): boolean {
    const announced = this.#announced.has(sessionID);
    this.release(sessionID);
    this.#announced.delete(sessionID);
    return announced;
  }
  release(sessionID: string): void {
    const hold = this.#holds.get(sessionID);
    if (hold === undefined) return;
    this.#holds.delete(sessionID);
    clearTimeout(hold.timer);
    hold.release();
  }
  delete(sessionID: string): void {
    this.release(sessionID);
    this.#announced.delete(sessionID);
    this.#adopted.delete(sessionID);
    clearTimeout(this.#notices.get(sessionID));
    this.#notices.delete(sessionID);
  }
  /** Releases every hold and notice and ignores later ones, since no event loop announces them. */
  stop(): void {
    this.#stopped = true;
    for (const sessionID of [...this.#holds.keys()]) this.release(sessionID);
    for (const timer of this.#notices.values()) clearTimeout(timer);
    this.#notices.clear();
    this.#announced.clear();
    this.#adopted.clear();
  }
  /**
   * A held session has finished its work, and a parent awaiting OmO's notice must look idle to
   * OmO, which otherwise waits for its turn to end.
   */
  status(session: SessionInfo, status: SessionStatus): SessionStatus {
    return this.#holds.has(session.id) || this.#notices.has(session.id)
      ? { type: SessionStatusKind.Idle }
      : status;
  }
  /** OmO reads an idle no sooner than `minTaskMs` after creating the child, then claims it. */
  #awaitClaim(sessionID: string, hold: Hold): void {
    const { claimMs, minTaskMs } = this.#bounds;
    this.#wait(sessionID, hold, Math.max(claimMs, hold.created + minTaskMs + claimMs - Date.now()));
  }
  #wait(sessionID: string, hold: Hold, ms: number): void {
    clearTimeout(hold.timer);
    hold.timer = setTimeout(() => {
      this.release(sessionID);
    }, ms);
    hold.timer.unref();
  }
}

export async function listSessions(
  context: Plugin.Context,
  request: Request,
): Promise<SessionInfo[]> {
  const directory = new URL(request.url).searchParams.get("directory") ?? undefined;
  const sessions = new Map<string, SessionInfo>();
  const requested = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor !== undefined) requested.add(cursor);
    const page = await context.session.list({ directory, cursor }, { signal: request.signal });
    for (const session of page.data) sessions.set(session.id, session);
    cursor = page.cursor.next ?? undefined;
    if (cursor !== undefined && requested.has(cursor)) {
      console.warn("omsago: Session pagination repeated a cursor", { cursor });
      break;
    }
  } while (cursor !== undefined);
  return [...sessions.values()];
}
