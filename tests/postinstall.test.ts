import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test.each([
  { name: "a missing directory", directory: false, contents: undefined },
  { name: "an existing directory", directory: true, contents: undefined },
  { name: "an existing config", directory: true, contents: '{\n  "custom": true\n}\n' },
  { name: "an empty config", directory: true, contents: "" },
])(
  "postinstall initializes or preserves configuration with $name",
  async ({ directory, contents }) => {
    const home = await mkdtemp(join(tmpdir(), "omsago-postinstall-"));
    const config = join(home, ".omsago", "omsago.json");
    try {
      if (directory) await mkdir(join(home, ".omsago"));
      if (contents !== undefined) await writeFile(config, contents);

      const child = Bun.spawn([process.execPath, "run", "postinstall"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      expect(exitCode, stderr).toBe(0);
      const actual = await readFile(config, "utf8");
      if (contents === undefined) expect(JSON.parse(actual)).toEqual({});
      else expect(actual).toBe(contents);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
