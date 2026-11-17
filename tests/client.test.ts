import { expect, test } from "bun:test";
import { runScenario } from "./fixtures/run-scenario.js";

test("the legacy client preserves discovery envelopes, session lifecycle, pagination and cancellation", async () => {
  const result = await runScenario("./client-scenario.ts");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ discovery: "passed", sessions: "passed", pagination: "passed", turns: "passed", errors: "passed", cancellation: "passed", events: "passed", compaction: "passed" });
}, 50_000);
