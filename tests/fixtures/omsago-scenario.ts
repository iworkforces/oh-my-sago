import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PartKind, ToolStateStatus } from "../../src/enums.js";
import { cliHost } from "./cli-host.js";
import { verifyDelegation } from "./omsago-delegation.js";
import { verifyGuard, verifyLifecycle } from "./omsago-lifecycle.js";

const directory = z.string().min(1).parse(process.argv[2]);
await mkdir(join(directory, ".omo"));
await Bun.write(
  join(directory, ".omo", "omo.json"),
  JSON.stringify({
    "[opencode]": {
      telemetry: false,
      model_fallback: false,
      disabled_mcps: ["websearch", "context7", "grep_app"],
      disabled_skills: ["security-research", "security-review"],
      agents: Object.fromEntries(
        [
          "build",
          "plan",
          "sisyphus",
          "hephaestus",
          "sisyphus-junior",
          "explore",
          "librarian",
          "oracle",
          "metis",
          "momus",
          "prometheus",
          "atlas",
          "multimodal-looker",
        ].map((name) => [name, { model: "omsago-test/scripted" }]),
      ),
      categories: Object.fromEntries(
        [
          "quick",
          "deep-low",
          "deep-high",
          "ultrabrain",
          "visual-engineering",
          "unspecified-low",
          "unspecified-high",
          "writing",
        ].map((name) => [name, { model: "omsago-test/scripted" }]),
      ),
    },
  }),
);
const sources = ["./provider-plugin/", "./omsago-plugin/"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);
await using host = await cliHost(directory, sources);
await host.request("/api/model");
const plugins = await host.request("/api/plugin");
const agents = z
  .object({ data: z.array(z.object({ id: z.string(), system: z.string().optional() })) })
  .parse(await host.request("/api/agent")).data;
assert.ok(
  agents.some(
    (agent) => agent.id.toLowerCase().includes("sisyphus") && (agent.system?.length ?? 0) > 100,
  ),
  JSON.stringify({ agents: agents.map((agent) => agent.id), plugins }),
);
const selected = agents.find((agent) => agent.id.toLowerCase().startsWith("sisyphus"));
assert.ok(selected);
const session = z.object({ data: z.object({ id: z.string() }) }).parse(
  await host.request("/api/session", {
    location: { directory },
    agent: selected.id,
    model: { providerID: "omsago-test", id: "scripted" },
  }),
).data;
const contextRecords = z.object({
  data: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(
          z.object({
            type: z.string(),
            name: z.string().optional(),
            text: z.string().optional(),
            state: z
              .object({
                status: z.string(),
                content: z.json().optional(),
                metadata: z.object({ name: z.string().optional() }).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    }),
  ),
});
const sessionParts = async (id: string) =>
  contextRecords
    .parse(await host.request(`/api/session/${id}/context`))
    .data.flatMap((record) => record.content ?? []);
await host.request(`/api/session/${session.id}/prompt`, { text: "Load the git-master skill." });
await host.request(`/api/session/${session.id}/command`, { name: "fixture-wait", text: "" });
const parts = await sessionParts(session.id);
assert.ok(
  parts.some(
    (part) =>
      part.type === PartKind.Tool &&
      part.name === "skill" &&
      part.state?.status === ToolStateStatus.Completed,
  ),
  JSON.stringify(parts),
);
assert.equal(
  parts.find((part) => part.type === PartKind.Tool && part.name === "skill")?.state?.metadata?.name,
  "git-master",
  "Completed skills must provide the name used by the native TUI.",
);
assert.ok(
  parts.some((part) => part.type === PartKind.Text && part.text === "omsago ready"),
  JSON.stringify(parts),
);
await host.request(`/api/session/${session.id}/prompt`, { text: "List the sessions." });
await host.request(`/api/session/${session.id}/command`, { name: "fixture-wait", text: "" });
const listed = (await sessionParts(session.id)).find(
  (part) => part.type === PartKind.Tool && part.name === "session_list",
);
assert.equal(listed?.state?.status, ToolStateStatus.Completed, JSON.stringify(listed));
const listing = JSON.stringify(listed.state.content);
assert.ok(listing.includes(session.id), listing);
assert.ok(!listing.includes("ENOTFOUND"), listing);
const delegation = await verifyDelegation(host, selected.id);
const guard = await verifyGuard(host, selected.id, directory);
const lifecycle = await verifyLifecycle(host, directory, sources);
console.log(
  JSON.stringify({
    activation: "passed",
    turn: "passed",
    skill: "passed",
    sessions: "passed",
    ...delegation,
    ...guard,
    ...lifecycle,
  }),
);
