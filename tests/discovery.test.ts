import { expect, test } from "bun:test";
import { cliVersion } from "./fixtures/cli-host.js";
import { runScenario } from "./fixtures/run-scenario.js";

test("user-root commands and skills are native and retain existing definitions on the pinned OpenCode CLI", async () => {
  const result = await runScenario("./discovery-scenario.ts");
  console.error(result.stderr);
  console.error(result.stdout.trim());
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    runtime: cliVersion(),
    missingRoots: "passed",
    commands: "passed",
    skills: "passed",
    skillLoading: "passed",
    precedence: "passed",
    protectedLinks: "passed",
    dotfilesLinks: "passed",
    rootSymlink: "passed",
    largeTree: "passed",
    unreadable: process.getuid?.() === 0 ? "skipped" : "passed",
  });
}, 110_000);
