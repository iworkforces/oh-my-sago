import { Plugin } from "@opencode/plugin/tui";
import { toastRpc } from "./toast.js";

const plugin: Plugin.Definition = Plugin.define({
  id: "omsago",
  setup(context) {
    // A toast that names a session belongs to that session's family, so it shows only while that family is open.
    const open = (sessionID: string): boolean => {
      const route = context.ui.router.current();
      return (
        route.type === "session" &&
        context.data.session.root(route.sessionID) === context.data.session.root(sessionID)
      );
    };
    const toast = (event: { readonly data: { readonly sessionID: string } }): void => {
      if (!open(event.data.sessionID)) return;
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
        if (sessionID !== undefined && !open(sessionID)) return;
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
