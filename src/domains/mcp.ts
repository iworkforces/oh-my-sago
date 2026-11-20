import type { Config } from "@opencode-ai/sdk";
import { Mcp, type Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { z } from "zod";
import { CompatibilityError, errorMessage } from "./value.js";
import { McpServerType } from "../enums.js";

/** Legacy configs may only toggle a server defined elsewhere; the SDK type omits that shape. */
type LegacyServer = NonNullable<Config["mcp"]>[string] | { readonly type?: undefined };
type ServerChange =
  | { readonly name: string; readonly toggle: boolean }
  | { readonly name: string; readonly definition: Mcp.ServerConfig };

const disabling = z.looseObject({ enabled: z.literal(false) });

function prepareServer(name: string, server: LegacyServer): ServerChange {
  if (server.type === undefined) {
    return { name, toggle: z.object({ enabled: z.boolean() }).strict().parse(server).enabled };
  }
  const { enabled, timeout } = server;
  const common = {
    ...(enabled === undefined ? {} : { disabled: !enabled }),
    ...(timeout === undefined
      ? {}
      : {
          timeout: new Mcp.TimeoutConfig({
            startup: timeout,
            catalog: timeout,
            execution: timeout,
          }),
        }),
  };
  switch (server.type) {
    case McpServerType.Local:
      return {
        name,
        definition: new Mcp.LocalConfig({
          type: McpServerType.Local,
          command: server.command,
          ...common,
          ...(server.environment === undefined ? {} : { environment: server.environment }),
        }),
      };
    case McpServerType.Remote: {
      const oauth = server.oauth;
      return {
        name,
        definition: new Mcp.RemoteConfig({
          type: McpServerType.Remote,
          url: server.url,
          ...common,
          ...(server.headers === undefined ? {} : { headers: server.headers }),
          ...(oauth === undefined
            ? {}
            : {
                oauth:
                  oauth === false
                    ? false
                    : new Mcp.OAuthConfig({
                        ...(oauth.clientId === undefined ? {} : { client_id: oauth.clientId }),
                        ...(oauth.clientSecret === undefined
                          ? {}
                          : { client_secret: oauth.clientSecret }),
                        ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
                      }),
              }),
        }),
      };
    }
    default:
      throw new CompatibilityError(`MCP ${name} has an unsupported type`);
  }
}

export async function registerMcp(context: Plugin.Context, config: Config): Promise<Registration> {
  const legacy: Readonly<Record<string, LegacyServer>> = config.mcp ?? {};
  const servers: ServerChange[] = [];
  for (const [name, server] of Object.entries(legacy)) {
    try {
      servers.push(prepareServer(name, server));
    } catch (error) {
      // A malformed entry never undoes a disable: the server still turns off if it is configured.
      const disable = disabling.safeParse(server).success;
      console.warn(
        disable
          ? "omsago: Disabling MCP server despite a malformed entry"
          : "omsago: Skipping MCP server with a malformed entry",
        { server: name, reason: errorMessage(error) },
      );
      if (disable) servers.push({ name, toggle: false });
    }
  }
  const unresolved = new Set<string>();
  return context.mcp.transform((editor) => {
    for (const server of servers) {
      if ("toggle" in server) {
        if (editor.get(server.name) === undefined) {
          // Only the host state knows whether a definition exists, and reloads rerun this callback.
          if (server.toggle && !unresolved.has(server.name)) {
            unresolved.add(server.name);
            console.warn("omsago: Skipping MCP server that has no definition to enable", {
              server: server.name,
            });
          }
          continue;
        }
        editor.update(server.name, (entry) => {
          entry.disabled = !server.toggle;
        });
      } else editor.set(server.name, server.definition);
    }
  });
}
