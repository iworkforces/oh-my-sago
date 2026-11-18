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
    cleanup: "passed",
    runtime: host.runtime,
  }),
);
