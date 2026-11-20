import { Plugin } from "@opencode/plugin";
import { createClientBridge } from "../../../src/client/index.js";
import { PartKind } from "../../../src/enums.js";
import { toastRpc } from "../../../src/toast.js";
import { scriptedProvider } from "../scripted-provider.js";
import { verifyClient } from "./contracts.js";
import { clientModel, clientVariants } from "./model.js";
import {
  verifyLifecycle,
  verifyLocationScope,
  verifyStability,
  verifyStop,
  verifyTodoFailure,
} from "./stability.js";
import { systemPrefix, systemProbe } from "./system.js";
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
    scope.defer(bridge.close);
    scope.defer(
      (
        await context.session.hook("retry", (event) => {
          if (event.decision.retry)
            event.decision = { retry: true, delay: model.retryDelay(event.sessionID) };
        })
      ).dispose,
    );
    const report = (sessionID: string, result: Record<string, string>) =>
      context.session.update({ sessionID, metadata: { "omsago.fixture": result } });
    await Bun.write(`${context.location.directory}/client.txt`, "client fixture content");
    const probe = systemProbe(context);
    scope.defer((await probe.tag()).dispose);
    scope.defer(
      await registerSessions(
        context,
        {
          async "chat.message"(input, output) {
            for (const part of output.parts) {
              if (part.type !== PartKind.Text) continue;
              if (part.text.includes("CLIENT_THINK"))
                Object.assign(output.message, { variant: "high" });
              if (part.text.includes("CLIENT_UNKNOWN_MODEL")) {
                const location = { directory: context.location.directory };
                const agents = (await context.agent.list({ location })).data;
                const other = agents.find((agent) => agent.id !== input.agent);
                if (other !== undefined) output.message.agent = other.id;
                output.message.model = { providerID: "omsago-test", modelID: "missing" };
              }
              part.text += " chat hook";
            }
          },
          async "experimental.chat.system.transform"(_input, output) {
            output.system.unshift(systemPrefix);
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
    scope.defer((await probe.check()).dispose);
    scope.defer(
      (
        await context.command.transform((editor) => {
          editor.add({
            name: "fixture-client-contracts",
            async execute(event) {
              const session = await context.session.get({ sessionID: event.sessionID });
              const result = await verifyClient({ context, bridge, session });
              const turns = await verifyTurns(context, bridge, model);
              const stability = await verifyStability(context, bridge);
              const stop = await verifyStop(context, bridge);
              const lifecycle = await verifyLifecycle(context, bridge, model);
              const locationScope = await verifyLocationScope(context, bridge);
              await report(event.sessionID, {
                ...result,
                ...turns,
                ...stability,
                ...stop,
                ...lifecycle,
                locationScope,
                systemMetadata: probe.verify(),
              });
            },
          });
          editor.add({
            name: "fixture-client-todos",
            async execute(event) {
              const todoSession = await verifyTodos(context, bridge);
              const todoFailure = await verifyTodoFailure(context, bridge);
              await report(event.sessionID, { todos: "passed", todoFailure, todoSession });
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
