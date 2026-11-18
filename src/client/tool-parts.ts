import type { SessionMessageAssistantTool } from "@opencode/client";
import type { ToolPart } from "@opencode-ai/sdk";
import { PartKind, ToolContentKind, ToolRunStatus, ToolStateStatus } from "../enums.js";
import { assertNever } from "./errors.js";
import { legacyArguments, jsonRecord } from "../domains/value.js";

export function legacyToolState(tool: SessionMessageAssistantTool): ToolPart["state"] {
  const start = tool.time.ran ?? tool.time.created;
  const end = tool.time.completed ?? start;
  const state = tool.state;
  const input =
    state.status === ToolRunStatus.Streaming
      ? {}
      : jsonRecord.parse(legacyArguments(tool.name, state.input));
  switch (state.status) {
    case ToolRunStatus.Streaming:
      return { status: ToolStateStatus.Pending, input: {}, raw: state.input };
    case ToolRunStatus.Running:
      return { status: ToolStateStatus.Running, input, metadata: state.metadata, time: { start } };
    case ToolRunStatus.Completed:
      return {
        status: ToolStateStatus.Completed,
        input,
        output: state.content
          .flatMap((part) => (part.type === ToolContentKind.Text ? [part.text] : []))
          .join("\n"),
        title: tool.name,
        metadata: state.metadata ?? {},
        time: { start, end },
        attachments: state.content.flatMap((part, index) =>
          part.type === ToolContentKind.File
            ? [
                {
                  type: PartKind.File,
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
    case ToolRunStatus.Error:
      return {
        status: ToolStateStatus.Error,
        input,
        error: state.error.message,
        ...(state.metadata === undefined ? {} : { metadata: state.metadata }),
        time: { start, end },
      };
    default:
      return assertNever(state);
  }
}
