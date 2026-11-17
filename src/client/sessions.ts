import type { Plugin } from "@opencode/plugin";
import type { SessionInfo } from "@opencode/client";
import type { Session, SessionStatus } from "@opencode-ai/sdk";

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

export function sessionStatus(session: SessionInfo): SessionStatus {
  const { busy, idle } = session.time;
  return busy !== undefined && (idle === undefined || busy > idle)
    ? { type: "busy" }
    : { type: "idle" };
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
