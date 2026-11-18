import { Plugin } from "@opencode/plugin";
import { omoPlugin } from "oh-my-openagent";
import { createClientBridge } from "./client/index.js";
import { registerDomains } from "./domains/index.js";
import { registerSessions } from "./session/index.js";
import { toastRpc } from "./toast.js";
import { registerUserDiscovery } from "./user-discovery.js";

export default Plugin.define({
  id: "omsago",
  async setup(context) {
    await using stack = new AsyncDisposableStack();
    const toasts = await context.rpc.register(toastRpc, {});
    stack.defer(toasts.dispose);
    const bridge = createClientBridge(context, toasts.events);
    stack.defer(bridge.dispose);
    const discovery = await registerUserDiscovery(context);
    stack.defer(discovery.dispose);
    const hooks = await omoPlugin(bridge.input, context.options);
    if (hooks.dispose !== undefined) stack.defer(hooks.dispose);
    const config = await bridge.input.client.config.get({ throwOnError: true });
    config.data.command = { ...discovery.commands, ...config.data.command };
    stack.defer(await registerDomains(context, hooks, config.data));
    stack.defer(await registerSessions(context, hooks, bridge.sessionState));
    await bridge.start(hooks);
    const owned = stack.move();
    return () => owned.disposeAsync();
  },
});
