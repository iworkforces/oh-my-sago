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
    const created = context.data.on("session.created", toast);
    const succeeded = context.data.on("session.execution.succeeded", toast);
    const forwarded = context.client.rpc(toastRpc).events.on("toast", (event) => {
      const { title, message, variant, duration } = event.data;
      context.ui.toast.show({
        ...(title === undefined ? {} : { title }),
        message,
        variant,
        ...(duration === undefined ? {} : { duration }),
      });
    });
    return () => {
      created();
      succeeded();
      forwarded();
    };
  },
});
