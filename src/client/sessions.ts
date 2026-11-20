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
