import { $ } from "bun";
import type { Plugin } from "@opencode/plugin";
import type { PluginInput, WorkspaceAdapter } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { createOpencodeClient as createSkillClient } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { type ToastEmitter, toast } from "../toast.js";
import { currentProject, discoveryRoute } from "./discovery.js";
import { BridgeError, errorResponse, unsupported } from "./errors.js";
import { type LegacyEventSink, clientEvents } from "./events.js";
import { body } from "./requests.js";
import { SessionRetries } from "./sessions.js";
import { sessionRoutes } from "./session-routes.js";
import { ClientSessionState } from "./state.js";

export type ClientBridge = {
  readonly input: PluginInput & {
    readonly client: PluginInput["client"] & {
      readonly app: PluginInput["client"]["app"] &
        Pick<ReturnType<typeof createSkillClient>["app"], "skills">;
    };
  };
  readonly sessionState: ClientSessionState;
  readonly start: (hooks: LegacyEventSink) => Promise<void>;
  readonly dispose: () => Promise<void>;
};

export function createClientBridge(context: Plugin.Context, toasts: ToastEmitter): ClientBridge {
  const sessionState = new ClientSessionState();
  const retries = new SessionRetries();
  const sessions = sessionRoutes(context, sessionState, retries);
  const events = clientEvents(context, retries);
  const showToast = async (request: Request): Promise<Response> => {
    const input = await body(request, toast);
    try {
      await toasts.emit("toast", input);
    } catch (error) {
      console.error("Client bridge could not deliver a toast", error);
    }
    return Response.json(true);
  };
  const serverUrl = new URL("http://omsago.invalid");
  const transport = async (
    input: string | Request | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? init === undefined
          ? input
          : new Request(input, init)
        : new Request(input.toString(), init);
    request.signal.throwIfAborted();
    try {
      const url = new URL(request.url);
      if (url.origin !== serverUrl.origin)
        throw new BridgeError(400, "The client bridge cannot route a foreign origin");
      const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (path[0] === "session") return await sessions(request, path);
      if (request.method === "POST" && url.pathname === "/tui/show-toast")
        return await showToast(request);
      return await discoveryRoute(context, request);
    } catch (error) {
      if (request.signal.aborted || !(error instanceof Error)) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError)
        return errorResponse(new BridgeError(400, error.message));
      return errorResponse(error);
    }
  };
  const config = {
    baseUrl: serverUrl.href,
    directory: context.location.directory,
    fetch: Object.assign(transport, {
      preconnect() {
        unsupported("fetch.preconnect");
      },
    }),
  };
  const client = createOpencodeClient(config);
  const skillClient = createSkillClient(config);
  const app = Object.assign(client.app, { skills: skillClient.app.skills.bind(skillClient.app) });
  const input = {
    client: Object.assign(client, { app }),
    project: currentProject(context),
    directory: context.location.directory,
    worktree: context.location.project.directory,
    serverUrl,
    $,
    experimental_workspace: {
      register(_type: string, _adapter: WorkspaceAdapter) {
        unsupported("experimental_workspace.register");
      },
    },
  } satisfies PluginInput;
  return {
    input,
    sessionState,
    start: (hooks: LegacyEventSink) => events.start(hooks),
    dispose: () => events.dispose(),
  };
}
