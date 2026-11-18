import { expect, test } from "bun:test";
import { runScenario } from "./fixtures/run-scenario.js";

test("user-root commands and skills are native and retain existing definitions on OpenCode 2.3.0", async () => {
  const result = await runScenario("./discovery-scenario.ts");
  console.error(result.stderr);
  console.error(result.stdout.trim());
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    runtime: "opencode v2.3.0",
    missingRoots: "passed",
    commands: "passed",
    skills: "passed",
    skillLoading: "passed",
    precedence: "passed",
  });
}, 110_000);
