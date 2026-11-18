import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cliHost } from "./cli-host.js";

const directory = z.string().min(1).parse(process.argv[2]);
await using host = await cliHost(directory, [
  fileURLToPath(new URL("./client-plugin/", import.meta.url)),
]);
await host.request("/api/model");
const session = z
  .object({ data: z.object({ id: z.string() }) })
  .parse(await host.request("/api/session", { location: { directory } })).data;
await host.request(`/api/session/${session.id}/command`, {
  name: "fixture-client-contracts",
  text: "",
});
const result = z
  .object({ data: z.object({ metadata: z.record(z.string(), z.json()) }) })
  .parse(await host.request(`/api/session/${session.id}`)).data;
console.log(JSON.stringify(result.metadata["omsago.fixture"]));
