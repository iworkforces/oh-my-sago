import assert from "node:assert/strict";
import { z } from "zod";
import { cliHost } from "./cli-host.js";

const directory = process.argv[2];
assert.ok(directory);
await using host = await cliHost(directory);
await host.request("/api/model");
const agents = z.object({ data: z.array(z.object({
  id: z.string(), system: z.string().optional(),
  permissions: z.array(z.object({ action: z.string(), effect: z.string() })),
})) });
const sessionInfo = z.object({ data: z.object({ id: z.string() }) });
const records = z.object({ data: z.array(z.object({
  type: z.string(), text: z.string().optional(),
  content: z.array(z.object({
    type: z.string(),
    state: z.object({ status: z.string(), content: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).optional() }).optional(),
  })).optional(),
})) });
const inventory = agents.parse(await host.request("/api/agent")).data;
const agent = inventory.find((item) => item.id === "bridge-fixture");
assert.equal(agent?.system, "Fixture instructions", JSON.stringify({ agents: inventory, plugins: await host.request("/api/plugin"), config: await host.request("/api/config") }));
assert.ok(agent.permissions.some((rule) => rule.action === "edit" && rule.effect === "deny"));

async function session(effect: "allow" | "deny") {
  return sessionInfo.parse(await host.request("/api/session", {
    location: { directory }, model: { providerID: "omsg-test", id: "scripted" }, agent: "bridge-fixture",
    permissions: [{ action: "bridge_echo", resource: "*", effect }],
  })).data;
}
const allowed = await session("allow");
await host.request(`/api/session/${allowed.id}/prompt`, { text: "Call the echo tool." });
await host.request(`/api/session/${allowed.id}/command`, { name: "fixture-wait", text: "" });
const context = records.parse(await host.request(`/api/session/${allowed.id}/context`)).data;
const result = context.flatMap((record) => record.type === "assistant" ? record.content ?? [] : [])
  .find((part) => part.type === "tool");
assert.equal(result?.type, "tool");
assert.equal(result.state?.status, "completed");
assert.deepEqual(result.state.content, [{ type: "text", text: "hello before after" }]);
assert.equal(result.state.metadata?.["owner"], "legacy");

const denied = await session("deny");
await host.request(`/api/session/${denied.id}/prompt`, { text: "Attempt the denied tool." });
await host.request(`/api/session/${denied.id}/command`, { name: "fixture-wait", text: "" });
const failures = records.parse(await host.request(`/api/session/${denied.id}/context`)).data
  .flatMap((record) => record.type === "assistant" ? record.content ?? [] : []);
assert.ok(failures.some((part) => part.type === "tool" && part.state?.status === "error"));

const command = sessionInfo.parse(await host.request("/api/session", {
  location: { directory }, model: { providerID: "omsg-test", id: "scripted" },
})).data;
await host.request(`/api/session/${command.id}/command`, { name: "bridge-command", text: "example" });
await host.request(`/api/session/${command.id}/command`, { name: "fixture-wait", text: "" });
const commandMessages = records.parse(await host.request(`/api/session/${command.id}/context`)).data;
assert.ok(commandMessages.some((message) => message.type === "user" && message.text === "Argument: example command hook"));
await host.request(`/api/session/${command.id}/command`, { name: "fixture-dispose", text: "" });
assert.equal(agents.parse(await host.request("/api/agent")).data.some((item) => item.id === "bridge-fixture"), false);
console.log(JSON.stringify({ tools: "passed", permissions: "passed", commands: "passed", cleanup: "passed", runtime: host.runtime }));
