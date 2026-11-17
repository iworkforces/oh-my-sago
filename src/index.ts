import { Plugin } from "@opencode/plugin";
import { omoPlugin } from "oh-my-openagent";
import { createClientBridge } from "./client/index.js";
import { registerDomains } from "./domains/index.js";
import { registerSessions } from "./session/index.js";

export default Plugin.define({
  id: "omsg",
  async setup(context) {
    const bridge = createClientBridge(context);
    const hooks = await omoPlugin(bridge.input, context.options);
    await using stack = new AsyncDisposableStack();
    if (hooks.dispose !== undefined) stack.defer(hooks.dispose);
    stack.defer(bridge.dispose);
    const config = await bridge.input.client.config.get({ throwOnError: true });
    stack.defer(await registerDomains(context, hooks, config.data));
    stack.defer(await registerSessions(context, hooks, bridge.sessionState));
    await bridge.start(hooks);
    const owned = stack.move();
    return () => owned.disposeAsync();
  },
});
