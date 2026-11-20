import { expect, test } from "bun:test";
import { runScenario } from "./fixtures/run-scenario.js";

test("the real OmO factory runs its agent and skill tool on the pinned OpenCode CLI", async () => {
  const result = await runScenario("./omsago-scenario.ts");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    activation: "passed",
    turn: "passed",
    skill: "passed",
    sessions: "passed",
    delegation: "passed",
    background: "passed",
    failure: "passed",
    cancellation: "passed",
    guard: "passed",
    lifecycle: "passed",
  });
}, 110_000);
