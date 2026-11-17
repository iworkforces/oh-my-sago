import { z } from "zod";

const effect = z.enum(["allow", "deny", "ask"]);
const rules = z.union([
  effect.transform((value) => ({ "*": value })),
  z.record(z.string(), z.union([effect, z.record(z.string(), effect)])),
]);

export function nativeAction(action: string): string {
  switch (action) {
    case "write":
    case "patch":
    case "apply_patch":
      return "edit";
    case "task":
      return "subagent";
    case "bash":
      return "shell";
    default:
      return action;
  }
}

export function nativePermissions(value: unknown) {
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
