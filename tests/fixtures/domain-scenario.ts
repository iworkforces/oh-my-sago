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
      permissions: z.array(z.object({ action: z.string(), effect: z.string() })),
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
for (const name of ["bridge-extra-key", "bridge-unsupported", "bridge-no-definition"])
  assert.equal(serverStatus[name], undefined, JSON.stringify(servers));

async function session(effect: PermissionEffect) {
  return sessionInfo.parse(
    await host.request("/api/session", {
      location: { directory },
      model: { providerID: "omsago-test", id: "scripted" },
      agent: "bridge-fixture",
      permissions: [{ action: "bridge_echo", resource: "*", effect }],
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
    isolatedAgents: "passed",
    isolatedMcp: "passed",
    isolatedTools: "passed",
    cleanup: "passed",
    runtime: host.runtime,
  }),
);
