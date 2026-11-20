import type { Hooks } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { permissionEffects } from "../enums.js";
import { forSession } from "../client/toast-session.js";
import { registerAgents } from "./agents.js";
import { registerCommands } from "./commands.js";
import { registerMcp } from "./mcp.js";
import { prepareTools, registerTools } from "./tools.js";
import { errorMessage, legacyName } from "./value.js";

const effect = z.enum(permissionEffects);
const environment = z.record(z.string(), z.string());

/** Runs a legacy hook that may only refine a native outcome; `false` keeps the native one. */
async function contained(hook: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    console.warn(`omsago: Keeping the native outcome after ${hook} failed`, {
      reason: errorMessage(error),
    });
    return false;
  }
}

export async function registerDomains(
  context: Plugin.Context,
  hooks: Hooks,
  config: Config,
): Promise<() => Promise<void>> {
  await using scope = new AsyncDisposableStack();
  await hooks.config?.(config);
  scope.defer((await registerAgents(context, config)).dispose);
  scope.defer((await registerCommands(context, hooks, config)).dispose);
  scope.defer((await registerMcp(context, config)).dispose);
  scope.defer(await registerTools(context, hooks, await prepareTools(context, hooks)));
  scope.defer(
    (
      await context.shell.hook("create.before", async (event) => {
        const output = {
          env: Object.fromEntries(
            Object.entries(event.env).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, value]],
            ),
          ),
        };
        const shellEnv = hooks["shell.env"];
        if (
          shellEnv !== undefined &&
          !(await contained("shell.env", () => shellEnv({ cwd: event.cwd }, output)))
        )
          return;
        const env = environment.safeParse(output.env);
        if (env.success) event.env = env.data;
        else console.warn("omsago: Ignoring a shell.env result whose values are not all strings");
      })
    ).dispose,
  );
  scope.defer(
    (
      await context.permission.hook("evaluate", async (event) => {
        const output = { status: event.effect };
        const ask = hooks["permission.ask"];
        if (ask === undefined) return;
        const asked = await contained("permission.ask", () =>
          forSession(event.sessionID, () =>
            ask(
              {
                id: event.source?.id ?? crypto.randomUUID(),
                type: legacyName(event.action),
                sessionID: event.sessionID,
                messageID: event.source?.messageID ?? "",
                ...(event.source === undefined ? {} : { callID: event.source.id }),
                pattern: [...event.resources],
                title: event.action,
                metadata: event.metadata ?? {},
                time: { created: Date.now() },
              },
              output,
            ),
          ),
        );
        if (!asked) return;
        const status = effect.safeParse(output.status);
        if (status.success) event.effect = status.data;
        else
          console.warn("omsago: Ignoring an invalid permission.ask status", {
            status: output.status,
          });
      })
    ).dispose,
  );
  const owned = scope.move();
  return () => owned.disposeAsync();
}
