import { Rpc } from "@opencode/plugin";
import { z } from "zod";
import { toastVariants } from "./enums.js";

export const toast = z.object({
  title: z.string().optional(),
  message: z.string(),
  variant: z.enum(toastVariants),
  duration: z.number().optional(),
});
export type Toast = z.infer<typeof toast>;

export const toastRpc = Rpc.define({
  id: "omsago",
  methods: {},
  events: { toast: { schema: toast } },
});

export type ToastEmitter = {
  readonly emit: (...args: Rpc.EventInput<typeof toastRpc>) => Promise<void>;
};
