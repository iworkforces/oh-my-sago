import { expect, test } from "bun:test";
import { cliVersion } from "./fixtures/cli-host.js";
import { runScenario } from "./fixtures/run-scenario.js";

test("native domains execute legacy tools, hooks, commands and permission rules", async () => {
  const result = await runScenario("./domain-scenario.ts");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    tools: "passed",
    permissions: "passed",
    commands: "passed",
    isolatedAgents: "passed",
    isolatedMcp: "passed",
    isolatedTools: "passed",
    cleanup: "passed",
    runtime: cliVersion(),
  });
}, 50_000);
