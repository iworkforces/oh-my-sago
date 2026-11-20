import { Rpc } from "@opencode/plugin";
import { z } from "zod";
import { toastVariants } from "./enums.js";

/** The legacy `/tui/show-toast` body. */
export const toast = z.object({
  title: z.string().optional(),
  message: z.string(),
  variant: z.enum(toastVariants),
  duration: z.number().optional(),
});

/** A toast for the TUI, naming the session whose OmO hook showed it when one did. */
export const sessionToast = toast.extend({ sessionID: z.string().optional() });
export type Toast = z.infer<typeof sessionToast>;

export const toastRpc = Rpc.define({
  id: "omsago",
  methods: {},
  events: { toast: { schema: sessionToast } },
});

export type ToastEmitter = {
  readonly emit: (...args: Rpc.EventInput<typeof toastRpc>) => Promise<void>;
};
