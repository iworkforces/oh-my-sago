import assert from "node:assert/strict";
import { OpenCode } from "@opencode/sdk";
import { answer, scriptedProvider, testModel } from "./scripted-provider.js";

const directory = process.argv[2];
assert.ok(directory, "Pass the isolated workspace directory.");

await using host = await OpenCode.create({
  config: { project: false, claude: false },
  models: { fetch: false, snapshot: false },
  fs: { filewatcher: false, fff: false },
  plugins: [scriptedProvider(async () => answer("scripted host is ready"))],
  fetch() {
    throw new UnexpectedNetworkRequest();
  },
});
const session = await host.sessions.create({ location: { directory }, model: testModel });
await host.sessions.prompt({ sessionID: session.id, text: "Run the local model." });
await host.sessions.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15_000) });
const messages = await host.sessions.context({ sessionID: session.id });
console.log(JSON.stringify({ session: await host.sessions.get({ sessionID: session.id }), messages }));

class UnexpectedNetworkRequest extends Error {
  constructor() {
    super("The local host scenario attempted an outbound HTTP request.");
    this.name = "UnexpectedNetworkRequest";
  }
}
