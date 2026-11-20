import { ErrorName } from "../enums.js";

/** Whether `error` is how work tied to `signal` reports that the signal aborted it. */
export function abortedBy(signal: AbortSignal, error: unknown): boolean {
  return (
    signal.aborted &&
    (error === signal.reason || (error instanceof Error && error.name === ErrorName.Abort))
  );
}

type Outcome<T> = { readonly value: T } | { readonly error: unknown };

/**
 * Settles like `work` unless `signal` aborts first, then rejects with the abort reason. The native
 * `context.*` calls ignore their `signal` option, so the bridge stops waiting here instead. The
 * abandoned work keeps running, and a failure it reports later is logged instead of surfacing as an
 * unhandled rejection.
 */
export async function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  const outcome = work.then(
    (value): Outcome<T> => ({ value }),
    (error: unknown): Outcome<T> => ({ error }),
  );
  const detach = new AbortController();
  const aborted = new Promise<undefined>((resolve) => {
    const settle = (): void => {
      resolve(undefined);
    };
    if (signal.aborted) settle();
    else signal.addEventListener("abort", settle, { once: true, signal: detach.signal });
  });
  const first = await Promise.race([outcome, aborted]);
  detach.abort();
  if (first === undefined) {
    void outcome.then((late) => {
      if ("error" in late && !abortedBy(signal, late.error))
        console.error("Client bridge work failed after it was abandoned", late.error);
    });
    throw signal.reason;
  }
  if ("error" in first) throw first.error;
  return first.value;
}
