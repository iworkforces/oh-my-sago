import type { Agent } from "@opencode/plugin";
import { z } from "zod";
import { LegacyAction, NativeAction, permissionEffects } from "../enums.js";

export type NativePermission = Agent.Info["permissions"][number];

const effect = z.enum(permissionEffects);
const rules = z.union([
  effect.transform((value) => ({ "*": value })),
  z.record(z.string(), z.union([effect, z.record(z.string(), effect)])),
]);

export function nativeAction(action: string): string {
  switch (action) {
    case LegacyAction.Write:
    case LegacyAction.Patch:
    case LegacyAction.ApplyPatch:
      return NativeAction.Edit;
    case LegacyAction.Task:
      return NativeAction.Subagent;
    case LegacyAction.Bash:
      return NativeAction.Shell;
    default:
      return action;
  }
}

export function nativePermissions(value: z.input<typeof rules> | undefined): NativePermission[] {
  return Object.entries(rules.parse(value ?? {})).flatMap(([key, rule]) => {
    const action = nativeAction(key);
    return typeof rule === "string"
      ? [{ action, resource: "*", effect: rule }]
      : Object.entries(rule).map(([resource, decision]) => ({
          action,
          resource,
          effect: decision,
        }));
  });
}
