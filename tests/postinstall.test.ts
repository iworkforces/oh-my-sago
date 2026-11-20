import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function install(home: string) {
  const child = Bun.spawn([process.execPath, "run", "postinstall"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

// `bun run` echoes the script command on stderr too, so only the script's own lines count.
function warnings(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.startsWith("omsago:"));
}

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

      const { exitCode, stderr } = await install(home);

      expect(exitCode, stderr).toBe(0);
      expect(warnings(stderr)).toEqual([]);
      const actual = await readFile(config, "utf8");
      if (contents === undefined) expect(JSON.parse(actual)).toEqual({});
      else expect(actual).toBe(contents);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  15_000,
);

test("postinstall warns about ~/.omsago and exits 0 when it is a file", async () => {
  const home = await mkdtemp(join(tmpdir(), "omsago-postinstall-"));
  const directory = join(home, ".omsago");
  try {
    await writeFile(directory, "not a directory");

    const { exitCode, stderr } = await install(home);

    expect(exitCode, stderr).toBe(0);
    expect(warnings(stderr)).toHaveLength(1);
    expect(warnings(stderr).join("\n")).toContain(directory);
    expect(await readFile(directory, "utf8")).toBe("not a directory");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

// A root user can write to a read-only directory, so this only runs unprivileged.
test.skipIf(process.getuid?.() === 0)(
  "postinstall warns about ~/.omsago and exits 0 when HOME is read-only",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "omsago-postinstall-"));
    try {
      await chmod(home, 0o555);

      const { exitCode, stderr } = await install(home);

      expect(exitCode, stderr).toBe(0);
      expect(warnings(stderr)).toHaveLength(1);
      expect(warnings(stderr).join("\n")).toContain(join(home, ".omsago"));
    } finally {
      await chmod(home, 0o755);
      await rm(home, { recursive: true, force: true });
    }
  },
  15_000,
);
