import { Plugin } from "@opencode/plugin";
import { createClientBridge } from "../../../src/client/index.js";
import { PartKind } from "../../../src/enums.js";
import { scriptedProvider } from "../scripted-provider.js";
import { verifyClient } from "./contracts.js";
import { clientModel } from "./model.js";
import { verifyTurns } from "./turns.js";
import { registerSessions } from "../../../src/session/index.js";

const model = clientModel();
const provider = scriptedProvider(model.script);

export default Plugin.define({
  id: "client-fixture",
  async setup(context) {
    await using scope = new AsyncDisposableStack();
    const providerCleanup = await provider.setup(context);
    if (providerCleanup) scope.defer(providerCleanup);
    const bridge = createClientBridge(context);
    scope.defer(bridge.dispose);
    await Bun.write(`${context.location.directory}/client.txt`, "client fixture content");
    scope.defer(
      await registerSessions(
        context,
        {
          async "chat.message"(_input, output) {
            for (const part of output.parts)
              if (part.type === PartKind.Text) part.text += " chat hook";
          },
          async "experimental.chat.system.transform"(_input, output) {
            output.system.push("system hook");
          },
          async "experimental.chat.messages.transform"(_input, output) {
            for (const message of output.messages)
              for (const part of message.parts)
                if (part.type === PartKind.Text) part.text += " messages hook";
          },
          async "chat.params"(_input, output) {
            output.temperature = 0.25;
          },
          async "experimental.session.compacting"(_input, output) {
            output.context.push("OMSG_COMPACTION_CONTEXT");
          },
        },
        bridge.sessionState,
      ),
    );
    scope.defer(
      (
        await context.command.transform((editor) => {
          editor.add({
            name: "fixture-client-contracts",
            async execute(event) {
              const session = await context.session.get({ sessionID: event.sessionID });
              const result = await verifyClient({ context, bridge, session });
              const turns = await verifyTurns(context, bridge, model.started);
              await context.session.update({
                sessionID: event.sessionID,
                metadata: { "omsg.fixture": { ...result, ...turns } },
              });
            },
          });
        })
      ).dispose,
    );
    const owned = scope.move();
    return () => owned.disposeAsync();
  },
});
