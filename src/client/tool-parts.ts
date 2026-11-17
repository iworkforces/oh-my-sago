import type { SessionMessageAssistantTool } from "@opencode/client";
import type { ToolPart } from "@opencode-ai/sdk";
import { assertNever } from "./errors.js";
import { legacyArguments, jsonRecord } from "../domains/value.js";

export function legacyToolState(tool: SessionMessageAssistantTool): ToolPart["state"] {
  const start = tool.time.ran ?? tool.time.created;
  const end = tool.time.completed ?? start;
  const state = tool.state;
  const input =
    state.status === "streaming" ? {} : jsonRecord.parse(legacyArguments(tool.name, state.input));
  switch (state.status) {
    case "streaming":
      return { status: "pending", input: {}, raw: state.input };
    case "running":
      return { status: "running", input, metadata: state.metadata, time: { start } };
    case "completed":
      return {
        status: "completed",
        input,
        output: state.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n"),
        title: tool.name,
        metadata: state.metadata ?? {},
        time: { start, end },
        attachments: state.content.flatMap((part, index) =>
          part.type === "file"
            ? [
                {
                  type: "file" as const,
                  id: `${tool.id}:file:${index}`,
                  sessionID: "",
                  messageID: "",
                  mime: part.mime,
                  url: part.uri,
                  ...(part.name == null ? {} : { filename: part.name }),
                },
              ]
            : [],
        ),
      };
    case "error":
      return {
        status: "error",
        input,
        error: state.error.message,
        ...(state.metadata === undefined ? {} : { metadata: state.metadata }),
        time: { start, end },
      };
    default:
      return assertNever(state);
  }
}
