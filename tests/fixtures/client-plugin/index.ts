import { Plugin } from "@opencode/plugin";
import { createClientBridge } from "../../../src/client/index.js";
import { PartKind } from "../../../src/enums.js";
import { toastRpc } from "../../../src/toast.js";
import { scriptedProvider } from "../scripted-provider.js";
import { verifyClient } from "./contracts.js";
import { clientModel, clientVariants } from "./model.js";
import { verifyRestoredTodos, verifyTodos } from "./todos.js";
import { verifyTurns } from "./turns.js";
import { registerSessions } from "../../../src/session/index.js";

const model = clientModel();
const provider = scriptedProvider(model.script, clientVariants);

export default Plugin.define({
  id: "client-fixture",
  async setup(context) {
    await using scope = new AsyncDisposableStack();
    const providerCleanup = await provider.setup(context);
    if (providerCleanup) scope.defer(providerCleanup);
    const toasts = await context.rpc.register(toastRpc, {});
    scope.defer(toasts.dispose);
    const bridge = createClientBridge(context, toasts.events);
    scope.defer(bridge.dispose);
    scope.defer(
      (
        await context.session.hook("retry", (event) => {
          if (event.decision.retry) event.decision = { retry: true, delay: 10 };
        })
      ).dispose,
    );
    const report = (sessionID: string, result: Record<string, string>) =>
      context.session.update({ sessionID, metadata: { "omsago.fixture": result } });
    await Bun.write(`${context.location.directory}/client.txt`, "client fixture content");
    scope.defer(
      await registerSessions(
        context,
        {
          async "chat.message"(_input, output) {
            for (const part of output.parts) {
              if (part.type !== PartKind.Text) continue;
              if (part.text.includes("CLIENT_THINK"))
                Object.assign(output.message, { variant: "high" });
              part.text += " chat hook";
            }
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
            output.context.push("omsago_COMPACTION_CONTEXT");
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
              const turns = await verifyTurns(context, bridge, model);
              await report(event.sessionID, { ...result, ...turns });
            },
          });
          editor.add({
            name: "fixture-client-todos",
            async execute(event) {
              const todoSession = await verifyTodos(context, bridge);
              await report(event.sessionID, { todos: "passed", todoSession });
            },
          });
          editor.add({
            name: "fixture-client-todo-read",
            async execute(event) {
              await verifyRestoredTodos(bridge, event.prompt.text.trim());
              await report(event.sessionID, { restart: "passed" });
            },
          });
        })
      ).dispose,
    );
    const owned = scope.move();
    return () => owned.disposeAsync();
  },
});
