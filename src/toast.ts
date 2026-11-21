import { Rpc } from "@opencode/plugin";
import { z } from "zod";
import { type ToastVariant, toastVariants } from "./enums.js";

type ToastShape = {
  title: z.ZodOptional<z.ZodString>;
  message: z.ZodString;
  variant: z.ZodEnum<{ [Variant in ToastVariant]: Variant }>;
  duration: z.ZodOptional<z.ZodNumber>;
};
/** The legacy `/tui/show-toast` body. */
export const toast: z.ZodObject<ToastShape> = z.object({
  title: z.string().optional(),
  message: z.string(),
  variant: z.enum(toastVariants),
  duration: z.number().optional(),
});

/** A toast for the TUI, naming the session whose OmO hook showed it when one did. */
export const sessionToast: z.ZodObject<ToastShape & { sessionID: z.ZodOptional<z.ZodString> }> =
  toast.extend({ sessionID: z.string().optional() });
export type Toast = z.infer<typeof sessionToast>;

export const toastRpc: {
  readonly id: "omsago";
  readonly methods: Readonly<Record<string, never>>;
  readonly events: { readonly toast: { readonly schema: typeof sessionToast } };
} = Rpc.define({
  id: "omsago",
  methods: {},
  events: { toast: { schema: sessionToast } },
});

export type ToastEmitter = {
  readonly emit: (...args: Rpc.EventInput<typeof toastRpc>) => Promise<void>;
};
