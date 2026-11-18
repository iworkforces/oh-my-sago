import type { Config } from "@opencode-ai/sdk";
import { Mcp, type Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { z } from "zod";
import { CompatibilityError } from "./value.js";
import { McpServerType } from "../enums.js";

/** Legacy configs may only toggle a server defined elsewhere; the SDK type omits that shape. */
type LegacyServer = NonNullable<Config["mcp"]>[string] | { readonly type?: undefined };
type ServerChange =
  | { readonly name: string; readonly toggle: boolean }
  | { readonly name: string; readonly definition: Mcp.ServerConfig };

export async function registerMcp(context: Plugin.Context, config: Config): Promise<Registration> {
  const legacy: Readonly<Record<string, LegacyServer>> = config.mcp ?? {};
  const servers = Object.entries(legacy).map(([name, server]): ServerChange => {
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
  });
  return context.mcp.transform((editor) => {
    for (const server of servers) {
      if ("toggle" in server) {
        if (editor.get(server.name) === undefined) {
          if (server.toggle)
            throw new CompatibilityError(`MCP ${server.name} has no definition to enable`);
          continue;
        }
        editor.update(server.name, (entry) => {
          entry.disabled = !server.toggle;
        });
      } else editor.set(server.name, server.definition);
    }
  });
}
