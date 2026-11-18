import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function runScenario(script: string) {
  const root = await mkdtemp(join(tmpdir(), "omsago-scenario-"));
  try {
    const names = ["home", "workspace", "config", "cache", "data", "state", "tmp"];
    await Promise.all(names.map((name) => mkdir(join(root, name))));
    const path = process.env["PATH"];
    assert.ok(path);
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        fileURLToPath(new URL(script, import.meta.url)),
        join(root, "workspace"),
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: {
          PATH: path,
          HOME: join(root, "home"),
          OPENCODE_TEST_HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"),
          TMPDIR: join(root, "tmp"),
          NODE_COMPILE_CACHE: join(root, "node-cache"),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 100_000,
      },
    );
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
