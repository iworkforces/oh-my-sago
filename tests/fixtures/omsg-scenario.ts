import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cliHost } from "./cli-host.js";
import { verifyDelegation } from "./omsg-delegation.js";
import { verifyGuard, verifyLifecycle } from "./omsg-lifecycle.js";

const directory = process.argv[2];
assert.ok(directory);
await mkdir(join(directory, ".omo"));
await Bun.write(join(directory, ".omo", "omo.json"), JSON.stringify({ "[opencode]": {
  telemetry: false, model_fallback: false, disabled_mcps: ["websearch", "context7", "grep_app"],
  disabled_skills: ["security-research", "security-review"],
  agents: Object.fromEntries(["build", "plan", "sisyphus", "hephaestus", "sisyphus-junior", "explore", "librarian", "oracle", "metis", "momus", "prometheus", "atlas", "multimodal-looker"].map((name) => [name, { model: "omsg-test/scripted" }])),
  categories: Object.fromEntries(["quick", "deep-low", "deep-high", "ultrabrain", "visual-engineering", "unspecified-low", "unspecified-high", "writing"].map((name) => [name, { model: "omsg-test/scripted" }])),
} }));
const sources = ["./provider-plugin/", "./omsg-plugin/"].map((path) => fileURLToPath(new URL(path, import.meta.url)));
await using host = await cliHost(directory, sources);
await host.request("/api/model");
const plugins = await host.request("/api/plugin");
const agents = z.object({ data: z.array(z.object({ id: z.string(), system: z.string().optional() })) }).parse(await host.request("/api/agent")).data;
assert.ok(agents.some((agent) => agent.id.toLowerCase().includes("sisyphus") && (agent.system?.length ?? 0) > 100), JSON.stringify({ agents: agents.map((agent) => agent.id), plugins }));
const selected = agents.find((agent) => agent.id.toLowerCase().startsWith("sisyphus"));
assert.ok(selected);
const session = z.object({ data: z.object({ id: z.string() }) }).parse(await host.request("/api/session", {
  location: { directory }, agent: selected.id, model: { providerID: "omsg-test", id: "scripted" },
})).data;
await host.request(`/api/session/${session.id}/prompt`, { text: "Load the git-master skill." });
await host.request(`/api/session/${session.id}/command`, { name: "fixture-wait", text: "" });
const records = z.object({ data: z.array(z.object({ type: z.string(), content: z.array(z.object({
  type: z.string(), name: z.string().optional(), text: z.string().optional(),
  state: z.object({ status: z.string(), content: z.unknown().optional() }).optional(),
})).optional() })) }).parse(await host.request(`/api/session/${session.id}/context`)).data;
const parts = records.flatMap((record) => record.content ?? []);
assert.ok(parts.some((part) => part.type === "tool" && part.name === "skill" && part.state?.status === "completed"), JSON.stringify(records));
assert.ok(parts.some((part) => part.type === "text" && part.text === "omsg ready"), JSON.stringify(records));
const delegation = await verifyDelegation(host, selected.id);
const guard = await verifyGuard(host, selected.id, directory);
const lifecycle = await verifyLifecycle(host, directory, sources);
console.log(JSON.stringify({ activation: "passed", turn: "passed", skill: "passed", ...delegation, ...guard, ...lifecycle }));
