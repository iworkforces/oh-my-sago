import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { toast, toastRpc } from "../../src/toast.js";
import { cliHost } from "./cli-host.js";
import { fixtureToast } from "./client-plugin/contracts.js";

const directory = z.string().min(1).parse(process.argv[2]);
await using host = await cliHost(directory, [
  fileURLToPath(new URL("./client-plugin/", import.meta.url)),
]);
await host.request("/api/model");
const toastEvent = `rpc.${toastRpc.id}.toast` as const;
const subscription = new AbortController();
const opencode = OpenCode.make({ baseUrl: host.url, fetch: host.locationFetch });
const stream = opencode.event.subscribe({ types: [toastEvent], signal: subscription.signal });
const events = stream[Symbol.asyncIterator]();
const next = async () => {
  const result = await events.next();
  assert.ok(result.done !== true, "The event subscription ended");
  return result.value;
};
try {
  assert.equal((await next()).type, "server.connected");
  const pending = next();
  const session = z
    .object({ data: z.object({ id: z.string() }) })
    .parse(await host.request("/api/session", { location: { directory } })).data;
  await host.request(`/api/session/${session.id}/command`, {
    name: "fixture-client-contracts",
    text: "",
  });
  const timer = setTimeout(() => {
    subscription.abort(new Error(`No ${toastEvent} event reached the subscriber`));
  }, 10_000);
  const delivered = await pending.finally(() => {
    clearTimeout(timer);
  });
  assert.ok(delivered.type === toastEvent, JSON.stringify(delivered));
  assert.deepEqual(toast.parse(delivered.data), fixtureToast);
  const result = z
    .object({ data: z.object({ metadata: z.record(z.string(), z.json()) }) })
    .parse(await host.request(`/api/session/${session.id}`)).data;
  console.log(JSON.stringify(result.metadata["omsago.fixture"]));
} finally {
  subscription.abort();
  await events.return?.();
}
