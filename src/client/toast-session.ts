import { AsyncLocalStorage } from "node:async_hooks";

interface Attribution {
  readonly sessionID: string;
  settled: boolean;
}

const attributions = new AsyncLocalStorage<Attribution>();

/**
 * Runs work that calls OmO hooks for a session. OmO's requests carry no session, so a toast
 * requested from this work is attributed to the session from here, and the TUI can tell it apart,
 * and an abort from it is known to come from that session's own work.
 *
 * The attribution lasts while the work runs and until the next macrotask after it settles, which
 * covers toasts OmO requests without awaiting them. Timers and pollers that OmO starts here inherit
 * the context but outlive the work, and one OmO poller serves the background tasks of every session,
 * so their later toasts stay unattributed instead of naming whichever session started them.
 */
export async function forSession<T>(sessionID: string, run: () => Promise<T>): Promise<T> {
  const attribution: Attribution = { sessionID, settled: false };
  try {
    return await attributions.run(attribution, run);
  } finally {
    setImmediate(() => {
      attribution.settled = true;
    });
  }
}

/** The session whose work made the current request, if any. */
export function attributedSession(): string | undefined {
  const attribution = attributions.getStore();
  return attribution?.settled === false ? attribution.sessionID : undefined;
}
