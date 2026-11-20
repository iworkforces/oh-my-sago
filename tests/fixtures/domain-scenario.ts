import assert from "node:assert/strict";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import {
  NativeAction,
  PartKind,
  PermissionEffect,
  RecordType,
  ToolStateStatus,
} from "../../src/enums.js";
import { cliHost } from "./cli-host.js";

const directory = z.string().min(1).parse(process.argv[2]);
await using host = await cliHost(directory);
await host.request("/api/model");
const agents = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      system: z.string().optional(),
      permissions: z.array(
        z.object({ action: z.string(), resource: z.string().optional(), effect: z.string() }),
      ),
    }),
  ),
});
const sessionInfo = z.object({ data: z.object({ id: z.string() }) });
const records = z.object({
  data: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      content: z
        .array(
          z.object({
            type: z.string(),
            state: z
              .object({
                status: z.string(),
                content: z.json().optional(),
                metadata: z.record(z.string(), z.json()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    }),
  ),
});
const inventory = agents.parse(await host.request("/api/agent")).data;
const agent = inventory.find((item) => item.id === "bridge-fixture");
assert.equal(
  agent?.system,
  "Fixture instructions",
  JSON.stringify({
    agents: inventory,
    plugins: await host.request("/api/plugin"),
    config: await host.request("/api/config"),
  }),
);
assert.ok(
  agent.permissions.some(
    (rule) => rule.action === NativeAction.Edit && rule.effect === PermissionEffect.Deny,
  ),
);

// Invalid global rules deny what they name instead of failing setup or widening access.
for (const rule of [
  { action: "bridge_valid", resource: "*", effect: PermissionEffect.Allow },
  { action: "bridge_global", resource: "*", effect: PermissionEffect.Deny },
  { action: "bridge_shape", resource: "*", effect: PermissionEffect.Deny },
  { action: "bridge_mixed", resource: "allowed/*", effect: PermissionEffect.Allow },
  { action: "bridge_mixed", resource: "odd/*", effect: PermissionEffect.Deny },
])
  assert.ok(
    agent.permissions.some(
      (entry) =>
        entry.action === rule.action &&
        entry.resource === rule.resource &&
        entry.effect === rule.effect,
    ),
    JSON.stringify({ rule, permissions: agent.permissions }),
  );

// A legacy `tools` toggle set to false denies that tool; an enabled toggle adds no rule.
assert.ok(
  agent.permissions.some(
    (rule) =>
      rule.action === "fixture_hidden" &&
      rule.resource === "*" &&
      rule.effect === PermissionEffect.Deny,
  ),
  JSON.stringify(agent.permissions),
);
assert.equal(
  agent.permissions.some((rule) => rule.action === "fixture_shown"),
  false,
  JSON.stringify(agent.permissions),
);

// Broken legacy overrides of native agents remove them instead of keeping their looser rules.
const agentIds = new Set(inventory.map((item) => item.id));
assert.ok(agentIds.has("bridge-seeded-control"), JSON.stringify(inventory));
for (const id of ["bridge-seeded-steps", "bridge-seeded-permission", "bridge-seeded-disabled"])
  assert.equal(agentIds.has(id), false, `${id} must be removed`);

// Malformed MCP entries are skipped, but a malformed toggle with enabled: false still disables.
const servers = z
  .object({
    data: z.array(z.object({ name: z.string(), status: z.object({ status: z.string() }) })),
  })
  .parse(await host.request("/api/mcp")).data;
const serverStatus = Object.fromEntries(servers.map((item) => [item.name, item.status.status]));
assert.equal(serverStatus["bridge-valid"], "disabled", JSON.stringify(servers));
assert.equal(serverStatus["bridge-configured"], "disabled", JSON.stringify(servers));
assert.equal(serverStatus["bridge-native"], "disabled", JSON.stringify(servers));
for (const name of ["bridge-extra-key", "bridge-unsupported", "bridge-no-definition"])
  assert.equal(serverStatus[name], undefined, JSON.stringify(servers));

async function session(effect: PermissionEffect, action = "bridge_echo") {
  return sessionInfo.parse(
    await host.request("/api/session", {
      location: { directory },
      model: { providerID: "omsago-test", id: "scripted" },
      agent: "bridge-fixture",
      permissions: [{ action, resource: "*", effect }],
    }),
  ).data;
}
const allowed = await session(PermissionEffect.Allow);
await host.request(`/api/session/${allowed.id}/prompt`, { text: "Call the echo tool." });
await host.request(`/api/session/${allowed.id}/command`, { name: "fixture-wait", text: "" });
const context = records.parse(await host.request(`/api/session/${allowed.id}/context`)).data;
const result = context
  .flatMap((record) => (record.type === RecordType.Assistant ? (record.content ?? []) : []))
  .find((part) => part.type === PartKind.Tool);
assert.equal(result?.type, PartKind.Tool);
assert.equal(result.state?.status, ToolStateStatus.Completed);
assert.deepEqual(result.state.content, [{ type: PartKind.Text, text: "hello before after" }]);
assert.equal(result.state.metadata?.["owner"], "legacy");

const denied = await session(PermissionEffect.Deny);
await host.request(`/api/session/${denied.id}/prompt`, { text: "Attempt the denied tool." });
await host.request(`/api/session/${denied.id}/command`, { name: "fixture-wait", text: "" });
const failures = records
  .parse(await host.request(`/api/session/${denied.id}/context`))
  .data.flatMap((record) => (record.type === RecordType.Assistant ? (record.content ?? []) : []));
assert.ok(
  failures.some(
    (part) => part.type === PartKind.Tool && part.state?.status === ToolStateStatus.Error,
  ),
);

// A failing or invalid legacy hook keeps the native outcome, and unrepresentable metadata degrades.
async function probe(mode: string) {
  const probing = await session(PermissionEffect.Allow, "bridge_probe");
  await host.request(`/api/session/${probing.id}/prompt`, { text: `Probe ${mode}.` });
  await host.request(`/api/session/${probing.id}/command`, { name: "fixture-wait", text: "" });
  const part = records
    .parse(await host.request(`/api/session/${probing.id}/context`))
    .data.flatMap((record) => (record.type === RecordType.Assistant ? (record.content ?? []) : []))
    .find((entry) => entry.type === PartKind.Tool);
  assert.equal(part?.state?.status, ToolStateStatus.Completed, JSON.stringify(part));
  return part.state;
}
for (const mode of ["throw-permission", "invalid-status"]) {
  const state = await probe(mode);
  assert.deepEqual(state.content, [{ type: PartKind.Text, text: `probe ${mode} asked` }]);
}
const unchanged = await probe("throw-after");
assert.deepEqual(unchanged.content, [{ type: PartKind.Text, text: "probe throw-after asked" }]);
assert.equal(unchanged.metadata?.["owner"], "probe");
assert.equal(unchanged.metadata?.["mutated"], undefined);
const degraded = await probe("cyclic");
assert.deepEqual(degraded.content, [{ type: PartKind.Text, text: "probe cyclic asked" }]);
assert.equal(degraded.metadata?.["owner"], "probe");
assert.equal(degraded.metadata?.["title"], "probe result");
assert.equal(degraded.metadata?.["cycle"], undefined);
assert.equal(degraded.metadata?.["big"], undefined);

const shelled = await session(PermissionEffect.Allow);
await host.request(`/api/session/${shelled.id}/shell`, {
  command: 'printf %s "${OMSAGO_FIXTURE_ENV:-native}"',
});
await host.request(`/api/session/${shelled.id}/command`, { name: "fixture-wait", text: "" });
const shell = z
  .object({
    data: z.array(
      z.object({
        type: z.string(),
        status: z.string().optional(),
        output: z.object({ output: z.string() }).optional(),
      }),
    ),
  })
  .parse(await host.request(`/api/session/${shelled.id}/context`))
  .data.find((record) => record.type === RecordType.Shell);
assert.equal(shell?.status, "exited", JSON.stringify(shell));
assert.equal(shell.output?.output, "native");

const listing = await session(PermissionEffect.Allow);
await host.request(`/api/session/${listing.id}/prompt`, { text: "List the tools." });
await host.request(`/api/session/${listing.id}/command`, { name: "fixture-wait", text: "" });
const listed = z
  .object({
    data: z.array(
      z.object({ content: z.array(z.object({ text: z.string().optional() })).optional() }),
    ),
  })
  .parse(await host.request(`/api/session/${listing.id}/context`))
  .data.flatMap((record) => record.content ?? [])
  .flatMap((part) => (part.text?.startsWith("TOOLS ") === true ? [part.text.slice(6)] : []))[0];
assert.ok(listed !== undefined, "The scripted provider did not report its tools");
const toolDescriptions = z.record(z.string(), z.string()).parse(JSON.parse(listed));
assert.ok("bridge_echo" in toolDescriptions, listed);
assert.equal("bridge_unrepresentable" in toolDescriptions, false, listed);
assert.ok("question" in toolDescriptions, listed);
assert.notEqual(toolDescriptions["question"], "reshaped before the hook failed");

const subscription = new AbortController();
const opencode = OpenCode.make({ baseUrl: host.url, fetch: host.locationFetch });
const stream = opencode.event.subscribe({ types: ["form.created"], signal: subscription.signal });
const events = stream[Symbol.asyncIterator]();
try {
  const connected = await events.next();
  assert.ok(connected.done !== true && connected.value.type === "server.connected");
  const pending = events.next();
  const asking = sessionInfo.parse(
    await host.request("/api/session", {
      location: { directory },
      model: { providerID: "omsago-test", id: "scripted" },
    }),
  ).data;
  await host.request(`/api/session/${asking.id}/prompt`, { text: "Ask a question." });
  const timer = setTimeout(() => {
    subscription.abort(new Error("No form.created event reached the subscriber"));
  }, 10_000);
  const created = await pending.finally(() => {
    clearTimeout(timer);
  });
  assert.ok(created.done !== true && created.value.type === "form.created");
  assert.equal(
    created.value.location?.directory,
    directory,
    "The native TUI only shows forms whose event carries a location.",
  );
  await opencode.session.form.cancel({
    sessionID: asking.id,
    formID: created.value.data.form.id,
    message: "fixture",
  });
  await host.request(`/api/session/${asking.id}/command`, { name: "fixture-wait", text: "" });
} finally {
  subscription.abort();
  await events.return?.();
}

const command = sessionInfo.parse(
  await host.request("/api/session", {
    location: { directory },
    model: { providerID: "omsago-test", id: "scripted" },
  }),
).data;
await host.request(`/api/session/${command.id}/command`, {
  name: "bridge-command",
  text: "example",
});
await host.request(`/api/session/${command.id}/command`, { name: "fixture-wait", text: "" });
const commandMessages = records.parse(
  await host.request(`/api/session/${command.id}/context`),
).data;
assert.ok(
  commandMessages.some(
    (message) =>
      message.type === RecordType.User && message.text === "Argument: example command hook",
  ),
);

// A command whose agent or model is rejected changes nothing and sends no prompt.
const selection = z.object({
  data: z.object({ agent: z.string().optional(), model: z.json().optional() }),
});
const guarded = sessionInfo.parse(
  await host.request("/api/session", {
    location: { directory },
    model: { providerID: "omsago-test", id: "scripted" },
  }),
).data;
const snapshot = async () => ({
  selection: selection.parse(await host.request(`/api/session/${guarded.id}`)).data,
  records: records.parse(await host.request(`/api/session/${guarded.id}/context`)).data.length,
});
const before = await snapshot();
for (const [name, reason] of [
  ["bridge-unlisted-model", /Unknown model omsago-test\/missing/],
  ["bridge-invalid-model", /model not-a-model/],
  ["bridge-missing-agent", /Unknown agent bridge-missing/],
] as const)
  await assert.rejects(
    host.request(`/api/session/${guarded.id}/command`, { name, text: "example" }),
    reason,
  );
assert.deepEqual(await snapshot(), before);

await host.request(`/api/session/${command.id}/command`, { name: "fixture-dispose", text: "" });
assert.equal(
  agents.parse(await host.request("/api/agent")).data.some((item) => item.id === "bridge-fixture"),
  false,
);
console.log(
  JSON.stringify({
    tools: "passed",
    permissions: "passed",
    commands: "passed",
    rejectedCommands: "passed",
    hookFailures: "passed",
    metadataFallback: "passed",
    globalPermissions: "passed",
    toolDenials: "passed",
    isolatedAgents: "passed",
    isolatedMcp: "passed",
    isolatedTools: "passed",
    cleanup: "passed",
    runtime: host.runtime,
  }),
);
