import { Plugin } from "@opencode/plugin/tui";
import { toastRpc } from "./toast.js";

const plugin: Plugin.Definition = Plugin.define({
  id: "omsago",
  setup(context) {
    // Naming the session lets the host title a toast from a session that is not open and offer it.
    const toast = (event: { readonly data: { readonly sessionID: string } }): void => {
      context.ui.toast.show({
        message: "Sago is now on Steroids, oMoMoMoMo...",
        variant: "success",
        duration: 5000,
        sessionID: event.data.sessionID,
      });
    };
    // A registration that throws unwinds the listeners before it, and the host sees the error.
    using stack = new DisposableStack();
    stack.defer(context.data.on("session.created", toast));
    stack.defer(context.data.on("session.execution.succeeded", toast));
    stack.defer(
      context.client.rpc(toastRpc).events.on("toast", (event) => {
        const { title, message, variant, duration, sessionID } = event.data;
        context.ui.toast.show({
          ...(title === undefined ? {} : { title }),
          message,
          variant,
          ...(duration === undefined ? {} : { duration }),
          ...(sessionID === undefined ? {} : { sessionID }),
        });
      }),
    );
    const owned = stack.move();
    return () => {
      owned.dispose();
    };
  },
});

export default plugin;
