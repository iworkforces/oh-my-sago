import type { Hooks } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode/plugin";
import { registerAgents } from "./agents.js";
import { registerCommands } from "./commands.js";
import { registerMcp } from "./mcp.js";
import { prepareTools, registerTools } from "./tools.js";
import { legacyName } from "./value.js";

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
  for (const dispose of await registerTools(context, hooks, await prepareTools(context, hooks)))
    scope.defer(dispose);
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
        await hooks["shell.env"]?.({ cwd: event.cwd }, output);
        event.env = output.env;
      })
    ).dispose,
  );
  scope.defer(
    (
      await context.permission.hook("evaluate", async (event) => {
        const output = { status: event.effect };
        await hooks["permission.ask"]?.(
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
        );
        event.effect = output.status;
      })
    ).dispose,
  );
  const owned = scope.move();
  return () => owned.disposeAsync();
}
