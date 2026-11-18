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

/** Pending provider retries, shared by one bridge's event loop and its status route. */
export class SessionRetries {
  readonly #pending = new Map<string, RetryStatus>();

  set(sessionID: string, status: RetryStatus): void {
    this.#pending.set(sessionID, status);
  }
  clear(sessionID: string): boolean {
    return this.#pending.delete(sessionID);
  }
  status(session: SessionInfo): SessionStatus {
    const retry = this.#pending.get(session.id);
    if (retry !== undefined) return retry;
    return isBusy(session) ? { type: SessionStatusKind.Busy } : { type: SessionStatusKind.Idle };
  }
}

export async function listSessions(
  context: Plugin.Context,
  request: Request,
): Promise<SessionInfo[]> {
  const directory = new URL(request.url).searchParams.get("directory") ?? undefined;
  const sessions: SessionInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await context.session.list({ directory, cursor }, { signal: request.signal });
    sessions.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor !== undefined);
  return sessions;
}
