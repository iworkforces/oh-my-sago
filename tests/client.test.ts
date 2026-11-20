import { expect, test } from "bun:test";
import { runScenario } from "./fixtures/run-scenario.js";

test("the legacy client preserves discovery envelopes, session lifecycle, pagination, cancellation and event recovery", async () => {
  const result = await runScenario("./client-scenario.ts");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    discovery: "passed",
    sessions: "passed",
    notFound: "passed",
    pagination: "passed",
    cursorCycle: "passed",
    invalidReleaseDate: "passed",
    turns: "passed",
    errors: "passed",
    cancellation: "passed",
    promptAbort: "passed",
    events: "passed",
    compaction: "passed",
    compactionCorrelation: "passed",
    toasts: "passed",
    retry: "passed",
    variants: "passed",
    queuedOverrides: "passed",
    overridesAfterFailure: "passed",
    rejectedSwitch: "passed",
    startup: "passed",
    recovery: "passed",
    coalescing: "passed",
    stalledHandler: "passed",
    stalledSeed: "passed",
    stoppedDelivery: "passed",
    closedTransport: "passed",
    successor: "passed",
    deletedByEvent: "passed",
    deletedByRoute: "passed",
    retryAfterStop: "passed",
    locationScope: "passed",
    systemMetadata: "passed",
  });
}, 90_000);

test("native todowrite lists reach the legacy todo API and survive compaction and restart", async () => {
  const result = await runScenario("./client-todo-scenario.ts");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    todos: "passed",
    todoFailure: "passed",
    restart: "passed",
  });
}, 90_000);
