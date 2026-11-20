import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type Json, json } from "../../src/domains/value.js";

const require = createRequire(import.meta.url);

function cliInstall() {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const manifest = require.resolve(`@opencode/cli-${platform}-${process.arch}/package.json`);
  const version = z.object({ version: z.string() }).parse(require(manifest)).version;
  const executable = join(
    dirname(manifest),
    "bin",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  );
  return { executable, runtime: `opencode v${version}` };
}

export function cliVersion(): string {
  return cliInstall().runtime;
}

export interface CliHost extends AsyncDisposable {
  readonly runtime: string;
  readonly url: string;
  readonly locationFetch: typeof globalThis.fetch;
  request(path: string, body?: Json): Promise<Json | undefined>;
}

export async function cliHost(
  directory: string,
  plugins: readonly string[] = [fileURLToPath(new URL("./domain-plugin/", import.meta.url))],
  settings: Readonly<Record<string, Json>> = {},
): Promise<CliHost> {
  const installed = cliInstall();
  const version = Bun.spawn([installed.executable, "--version"], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const runtime = (await new Response(version.stdout).text()).trim();
  assert.equal(await version.exited, 0);
  assert.equal(runtime, installed.runtime);
  const config = join(directory, "opencode.json");
  await Bun.write(
    config,
    JSON.stringify({
      ...settings,
      plugins,
      model: "omsago-test/scripted",
    }),
  );
  const password = crypto.randomUUID();
  const child = Bun.spawn(
    [
      installed.executable,
      "--print-logs",
      "--log-level",
      "warn",
      "serve",
      "--stdio",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        OPENCODE_CONFIG: config,
        OPENCODE_CONFIG_DIR: dirname(config),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_FILEWATCHER: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
    },
  );
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const stop = async () => {
    await child.stdin.end();
    if (child.exitCode === null) child.kill();
    const exitCode = await child.exited;
    await reader.cancel();
    console.error(
      JSON.stringify({
        cli: runtime,
        pid: child.pid,
        exitCode,
        teardown: "process exited; stdio closed",
      }),
    );
    const logs = await stderr;
    if (logs) console.error(logs);
  };
  try {
    let output = "";
    let address: string | undefined;
    while (address === undefined) {
      const chunk = await reader.read();
      assert.equal(
        chunk.done,
        false,
        `CLI exited before listening: ${output}\n${await (chunk.done ? stderr : Promise.resolve(""))}`,
      );
      output += decoder.decode(chunk.value, { stream: true });
      for (const line of output.split("\n").slice(0, -1)) {
        if (line.startsWith("{")) address = z.object({ url: z.url() }).parse(JSON.parse(line)).url;
      }
    }
    const base = address;
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const scoped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const url = new URL(request.url);
      url.searchParams.set("location[directory]", directory);
      const located = new Request(url.toString(), request);
      located.headers.set("authorization", authorization);
      return fetch(located);
    };
    return {
      runtime,
      url: base,
      locationFetch: Object.assign(scoped, { preconnect: fetch.preconnect }),
      async request(path: string, body?: Json): Promise<Json | undefined> {
        const url = new URL(path, base);
        const response = await scoped(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        assert.ok(response.ok, `${response.status} ${url.pathname}: ${text}`);
        return text === "" ? undefined : json.parse(JSON.parse(text));
      },
      async [Symbol.asyncDispose]() {
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
