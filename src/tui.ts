import { Plugin } from "@opencode/plugin/tui";
import { toastRpc } from "./toast.js";

export default Plugin.define({
  id: "omsago",
  setup(context) {
    const toast = (): void => {
      context.ui.toast.show({
        message: "Sago is now on Steroids, oMoMoMoMo...",
        variant: "success",
        duration: 5000,
      });
    };
    // A registration that throws unwinds the listeners before it, and the host sees the error.
    using stack = new DisposableStack();
    stack.defer(context.data.on("session.created", toast));
    stack.defer(context.data.on("session.execution.succeeded", toast));
    stack.defer(
      context.client.rpc(toastRpc).events.on("toast", (event) => {
        const { title, message, variant, duration } = event.data;
        context.ui.toast.show({
          ...(title === undefined ? {} : { title }),
          message,
          variant,
          ...(duration === undefined ? {} : { duration }),
        });
      }),
    );
    const owned = stack.move();
    return () => {
      owned.dispose();
    };
  },
});
