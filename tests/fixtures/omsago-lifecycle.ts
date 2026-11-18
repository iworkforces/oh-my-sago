import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PartKind, ToolStateStatus } from "../../src/enums.js";
import type { CliHost } from "./cli-host.js";

const agents = z.object({ data: z.array(z.object({ id: z.string() })) });
const session = z.object({ data: z.object({ id: z.string() }) });
const records = z.object({
  data: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(
          z.object({
            type: z.string(),
            name: z.string().optional(),
            text: z.string().optional(),
            state: z.object({ status: z.string(), error: z.json().optional() }).optional(),
          }),
        )
        .optional(),
    }),
  ),
});

export async function verifyGuard(
  host: CliHost,
  agent: string,
  directory: string,
): Promise<Readonly<Record<"guard", "passed">>> {
  await Bun.write(join(directory, "guard.txt"), "original");
  const created = session.parse(
    await host.request("/api/session", {
      agent,
      model: { providerID: "omsago-test", id: "scripted" },
    }),
  ).data;
  await host.request(`/api/session/${created.id}/prompt`, { text: "omsago_GUARD" });
  await host.request(`/api/session/${created.id}/command`, { name: "fixture-wait", text: "" });
  const parts = records
    .parse(await host.request(`/api/session/${created.id}/context`))
    .data.flatMap((record) => record.content ?? []);
  const write = parts.find((part) => part.type === PartKind.Tool && part.name === "write");
  assert.equal(write?.state?.status, ToolStateStatus.Error, JSON.stringify(parts));
  assert.match(JSON.stringify(write.state.error), /read/i);
  assert.equal(await readFile(join(directory, "guard.txt"), "utf8"), "original");
  return { guard: "passed" } as const;
}

export async function verifyLifecycle(
  host: CliHost,
  directory: string,
  plugins: readonly string[],
): Promise<Readonly<Record<"lifecycle", "passed">>> {
  const receipts = async () =>
    (await readFile(join(directory, "cleanup.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        z
          .object({
            id: z.literal("omsago"),
            event: z.enum(["setup", "cleanup"]),
            instance: z.string(),
            directory: z.string(),
          })
          .parse(JSON.parse(line)),
      );
  const active = async () => {
    const events = await receipts();
    return events.filter(
      (event) =>
        event.event === "setup" &&
        !events.some((other) => other.instance === event.instance && other.event === "cleanup"),
    );
  };
  const closed = async (instances: Awaited<ReturnType<typeof active>>) => {
    const events = await receipts();
    assert.ok(instances.length > 0);
    for (const instance of instances)
      assert.equal(
        events.filter((event) => event.event === "cleanup" && event.instance === instance.instance)
          .length,
        1,
        JSON.stringify(events),
      );
  };
  const initial = await active();
  const before = agents
    .parse(await host.request("/api/agent"))
    .data.map((agent) => agent.id)
    .sort();
  await host.request("/api/location/reload", {});
  await host.request("/api/model");
  assert.deepEqual(
    agents
      .parse(await host.request("/api/agent"))
      .data.map((agent) => agent.id)
      .sort(),
    before,
  );
  await closed(initial);
  const replaced = await active();
  await Bun.write(
    join(directory, "opencode.json"),
    JSON.stringify({ plugins: plugins.slice(0, 1), model: "omsago-test/scripted" }),
  );
  await host.request("/api/location/reload", {});
  await host.request("/api/model");
  assert.equal(
    agents
      .parse(await host.request("/api/agent"))
      .data.some((agent) => agent.id.toLowerCase().includes("sisyphus")),
    false,
  );
  await closed(replaced);
  assert.equal((await active()).length, 0);
  await Bun.write(
    join(directory, "opencode.json"),
    JSON.stringify({ plugins, model: "omsago-test/scripted" }),
  );
  await host.request("/api/location/reload", {});
  await host.request("/api/model");
  assert.deepEqual(
    agents
      .parse(await host.request("/api/agent"))
      .data.map((agent) => agent.id)
      .sort(),
    before,
  );
  const agent = before.find((id) => id.toLowerCase().startsWith("sisyphus"));
  assert.ok(agent !== undefined);
  const created = session.parse(
    await host.request("/api/session", {
      agent,
      model: { providerID: "omsago-test", id: "scripted" },
    }),
  ).data;
  await host.request(`/api/session/${created.id}/prompt`, {
    text: "Load the git-master skill after reload.",
  });
  await host.request(`/api/session/${created.id}/command`, { name: "fixture-wait", text: "" });
  const parts = records
    .parse(await host.request(`/api/session/${created.id}/context`))
    .data.flatMap((record) => record.content ?? []);
  assert.equal(
    parts.filter(
      (part) => part.name === "skill" && part.state?.status === ToolStateStatus.Completed,
    ).length,
    1,
    JSON.stringify(parts),
  );
  return { lifecycle: "passed" } as const;
}
