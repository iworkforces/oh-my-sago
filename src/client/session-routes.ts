import type { Plugin } from "@opencode/plugin";
import { BridgeError, unsupported } from "./errors.js";
import { legacyMessages } from "./messages.js";
import { body, createBody, updateBody } from "./requests.js";
import { legacySession, listSessions, sessionStatus } from "./sessions.js";
import { permissionRules, type ClientSessionState } from "./state.js";
import { promptRoutes } from "./prompts.js";

export function sessionRoutes(context: Plugin.Context, state: ClientSessionState) {
  const prompt = promptRoutes(context, state);
  return async (request: Request, path: readonly string[]): Promise<Response> => {
    const options = { signal: request.signal };
    const sessionID = path[1];
    const operation = path[2];
    if (sessionID === undefined) {
      if (request.method === "GET")
        return Response.json((await listSessions(context, request)).map(legacySession));
      if (request.method === "POST") {
        const input = await body(request, createBody);
        const directory =
          new URL(request.url).searchParams.get("directory") ?? context.location.directory;
        const { permission: rules, model, ...fields } = input;
        const session = await context.session.create(
          {
            ...fields,
            location: { directory },
            model:
              model === undefined
                ? undefined
                : {
                    id: model.id,
                    providerID: model.providerID,
                    ...(model.variant === undefined ? {} : { variant: model.variant }),
                  },
            permissions: rules === undefined ? undefined : permissionRules(rules),
          },
          options,
        );
        return Response.json(legacySession(session));
      }
    }
    if (sessionID === "status" && request.method === "GET") {
      const sessions = await listSessions(context, request);
      return Response.json(
        Object.fromEntries(sessions.map((session) => [session.id, sessionStatus(session)])),
      );
    }
    if (sessionID === undefined) return unsupported(`session ${request.method}`);
    if (operation === undefined && path.length === 2) {
      switch (request.method) {
        case "GET":
          return Response.json(legacySession(await context.session.get({ sessionID }, options)));
        case "PATCH": {
          const input = await body(request, updateBody);
          await context.session.update(
            {
              sessionID,
              title: input.title,
              permissions:
                input.permission === undefined ? undefined : permissionRules(input.permission),
              archived: input.time?.archived === undefined ? undefined : input.time.archived > 0,
            },
            options,
          );
          return Response.json(legacySession(await context.session.get({ sessionID }, options)));
        }
        case "DELETE":
          await context.session.remove({ sessionID }, options);
          state.delete(sessionID);
          return Response.json(true);
      }
    }
    if (operation === "abort" && request.method === "POST") {
      const result = await context.session.interrupt({ sessionID }, options);
      return Response.json(result.interrupted);
    }
    if (operation === "message" && request.method === "GET") {
      const session = await context.session.get({ sessionID }, options);
      const records = await context.session.context({ sessionID }, options);
      const messages = legacyMessages(session, records);
      const messageID = path[3];
      if (messageID !== undefined) {
        const message = messages.find((entry) => entry.info.id === messageID);
        if (message === undefined) throw new BridgeError(404, `Message ${messageID} was not found`);
        return Response.json(message);
      }
      const limit = new URL(request.url).searchParams.get("limit");
      if (limit === null) return Response.json(messages);
      const count = Number(limit);
      if (!Number.isSafeInteger(count) || count < 0)
        throw new BridgeError(400, "Message limit must be a nonnegative integer");
      return Response.json(count === 0 ? [] : messages.slice(-count));
    }
    if (
      request.method === "POST" &&
      path.length === 3 &&
      (operation === "message" || operation === "prompt_async" || operation === "summarize")
    ) {
      return prompt(request, sessionID, operation);
    }
    return unsupported(`${request.method} /${path.join("/")}`);
  };
}
