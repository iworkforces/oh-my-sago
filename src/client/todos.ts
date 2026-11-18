import type { Plugin } from "@opencode/plugin";
import type { SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { Todo } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import {
  AssistantContentKind,
  NativeTool,
  RecordType,
  TodoPriority,
  ToolRunStatus,
  todoStatuses,
} from "../enums.js";

const key = "omsago.todo";
const nativeTodos = z.array(
  z.object({ content: z.string(), status: z.enum(todoStatuses) }).strip(),
);
type NativeTodo = z.infer<typeof nativeTodos>[number];
type Options = { readonly signal: AbortSignal };

function legacyTodos(todos: readonly NativeTodo[]): Todo[] {
  return todos.map((todo) => ({
    content: todo.content,
    status: todo.status,
    priority: TodoPriority.Medium,
  }));
}

function storedTodos(session: SessionInfo): NativeTodo[] {
  const stored = session.metadata?.[key];
  return stored === undefined ? [] : nativeTodos.parse(stored);
}

/** Reads the latest list, or none while the `todo` flag keeps `todowrite` unregistered. */
export async function sessionTodos(
  context: Plugin.Context,
  sessionID: string,
  options: Options,
): Promise<Todo[]> {
  const [tools, session] = await Promise.all([
    context.tool.list(),
    context.session.get({ sessionID }, options),
  ]);
  if (!tools.some((tool) => tool.name === NativeTool.TodoWrite)) return [];
  return legacyTodos(storedTodos(session));
}

/**
 * Persists the list written by a successful `todowrite` call and returns it in the legacy shape.
 * Tool events carry no tool name, so the call is identified from the session's tool records.
 */
export async function recordTodos(
  context: Plugin.Context,
  sessionID: string,
  call: { readonly assistantMessageID: string; readonly id: string },
  records: readonly SessionMessageInfo[],
  options: Options,
): Promise<Todo[] | undefined> {
  const assistant = records.find(
    (record) => record.type === RecordType.Assistant && record.id === call.assistantMessageID,
  );
  const tool =
    assistant?.type === RecordType.Assistant
      ? assistant.content.find(
          (content) => content.type === AssistantContentKind.Tool && content.id === call.id,
        )
      : undefined;
  if (
    tool?.type !== AssistantContentKind.Tool ||
    tool.name !== NativeTool.TodoWrite ||
    tool.state.status !== ToolRunStatus.Completed
  )
    return undefined;
  const todos = z.object({ todos: nativeTodos }).parse(tool.state.input).todos;
  const session = await context.session.get({ sessionID }, options);
  await context.session.update(
    { sessionID, metadata: { ...session.metadata, [key]: todos } },
    options,
  );
  return legacyTodos(todos);
}
