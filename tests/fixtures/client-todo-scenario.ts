import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type CliHost, cliHost } from "./cli-host.js";

const directory = z.string().min(1).parse(process.argv[2]);
const plugins = [fileURLToPath(new URL("./client-plugin/", import.meta.url))];
const settings = { experimental: { todo: true } };
const fixture = z.object({
  data: z.object({ metadata: z.object({ "omsago.fixture": z.record(z.string(), z.string()) }) }),
});

async function command(host: CliHost, name: string, text: string) {
  const session = z
    .object({ data: z.object({ id: z.string() }) })
    .parse(await host.request("/api/session", { location: { directory } })).data;
  await host.request(`/api/session/${session.id}/command`, { name, text });
  return fixture.parse(await host.request(`/api/session/${session.id}`)).data.metadata[
    "omsago.fixture"
  ];
}

const written = await (async () => {
  await using host = await cliHost(directory, plugins, settings);
  return await command(host, "fixture-client-todos", "");
})();
const todoSession = z.string().parse(written["todoSession"]);
const restored = await (async () => {
  await using host = await cliHost(directory, plugins, settings);
  return await command(host, "fixture-client-todo-read", todoSession);
})();
console.log(
  JSON.stringify({
    todos: written["todos"],
    todoFailure: written["todoFailure"],
    restart: restored["restart"],
  }),
);
