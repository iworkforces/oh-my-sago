import type { Plugin } from "@opencode/plugin";
import type { SessionInfo } from "@opencode/client";
import type { Session, SessionStatus } from "@opencode-ai/sdk";
import { SessionStatusKind } from "../enums.js";

export function legacySession(session: SessionInfo): Session {
  return {
    id: session.id,
    projectID: session.projectID,
    directory: session.location.directory,
    ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
    title: session.title ?? "",
    version: "2.3.0",
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
