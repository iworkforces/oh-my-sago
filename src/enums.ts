import type { ContentPart, ToolResultPart } from "@opencode/ai";
import type {
  OpenCodeEvent,
  PromptFileSource,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageCompaction,
  SessionMessageInfo,
} from "@opencode/client";
import type { SessionModelResolve, SessionRequest } from "@opencode/plugin/promise/session";
import type {
  AssistantMessage,
  BadRequestError,
  Config,
  Event,
  Part,
  SessionStatus,
  ToolPart,
  TuiShowToastData,
} from "@opencode-ai/sdk";

/**
 * String-literal vocabularies shared by the native v2 and legacy SDK shapes.
 *
 * Every object keeps its members as literal types, so comparisons and `switch`
 * clauses narrow exactly like inline literals. Each `satisfies` clause rejects
 * a member the corresponding SDK union does not define; an exhaustive `switch`
 * with `assertNever` rejects a union member this module has not named.
 */

export const RecordType = {
  AgentSwitched: "agent-switched",
  ModelSwitched: "model-switched",
  LocationSwitched: "location-switched",
  User: "user",
  Synthetic: "synthetic",
  System: "system",
  Skill: "skill",
  Shell: "shell",
  Assistant: "assistant",
  Compaction: "compaction",
  Idle: "idle",
} as const satisfies Record<string, SessionMessageInfo["type"]>;
export type RecordType = (typeof RecordType)[keyof typeof RecordType];

export const MessageRole = {
  System: "system",
  User: "user",
  Assistant: "assistant",
  Tool: "tool",
} as const satisfies Record<string, SessionRequest["messages"][number]["role"]>;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export const ContentKind = {
  Text: "text",
  Reasoning: "reasoning",
  Media: "media",
  ToolCall: "tool-call",
  ToolResult: "tool-result",
  Compaction: "compaction",
  Effort: "effort",
} as const satisfies Record<string, ContentPart["type"]>;
export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind];

export const PartKind = {
  Text: "text",
  Reasoning: "reasoning",
  File: "file",
  Tool: "tool",
  StepStart: "step-start",
  StepFinish: "step-finish",
  Snapshot: "snapshot",
  Patch: "patch",
  Agent: "agent",
  Retry: "retry",
  Compaction: "compaction",
  Subtask: "subtask",
} as const satisfies Record<string, Part["type"]>;
export type PartKind = (typeof PartKind)[keyof typeof PartKind];

type ToolContentType = Extract<
  ToolResultPart["result"],
  { type: "content" }
>["value"][number]["type"];
export const ToolContentKind = {
  Text: "text",
  File: "file",
} as const satisfies Record<string, ToolContentType>;
export type ToolContentKind = (typeof ToolContentKind)[keyof typeof ToolContentKind];

export const ToolResultKind = {
  Error: "error",
  Text: "text",
  Json: "json",
  Content: "content",
} as const satisfies Record<string, ToolResultPart["result"]["type"]>;
export type ToolResultKind = (typeof ToolResultKind)[keyof typeof ToolResultKind];

export const ToolStateStatus = {
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Error: "error",
} as const satisfies Record<string, ToolPart["state"]["status"]>;
export type ToolStateStatus = (typeof ToolStateStatus)[keyof typeof ToolStateStatus];

export const ToolRunStatus = {
  Streaming: "streaming",
  Running: "running",
  Completed: "completed",
  Error: "error",
} as const satisfies Record<string, SessionMessageAssistantTool["state"]["status"]>;
export type ToolRunStatus = (typeof ToolRunStatus)[keyof typeof ToolRunStatus];

export const AssistantContentKind = {
  Text: "text",
  Reasoning: "reasoning",
  Tool: "tool",
} as const satisfies Record<string, SessionMessageAssistant["content"][number]["type"]>;
export type AssistantContentKind = (typeof AssistantContentKind)[keyof typeof AssistantContentKind];

export const SessionStatusKind = {
  Busy: "busy",
  Retry: "retry",
  Idle: "idle",
} as const satisfies Record<string, SessionStatus["type"]>;
export type SessionStatusKind = (typeof SessionStatusKind)[keyof typeof SessionStatusKind];

type SessionOutcomeValue = NonNullable<SessionInfo["outcome"]>;
export const SessionOutcome = {
  Succeeded: "succeeded",
  Failed: "failed",
  Interrupted: "interrupted",
} as const satisfies Record<string, SessionOutcomeValue>;
export type SessionOutcome = (typeof SessionOutcome)[keyof typeof SessionOutcome];

type MediaSourceType = Extract<ContentPart, { type: "media" }>["media"]["source"]["type"];
export const MediaSourceKind = {
  Url: "url",
  Ref: "ref",
  Base64: "base64",
  Bytes: "bytes",
} as const satisfies Record<string, MediaSourceType>;
export type MediaSourceKind = (typeof MediaSourceKind)[keyof typeof MediaSourceKind];

type McpServer = NonNullable<Config["mcp"]>[string];
type McpServerTypeValue = Extract<McpServer, { type: string }>["type"];
export const McpServerType = {
  Local: "local",
  Remote: "remote",
} as const satisfies Record<string, McpServerTypeValue>;
export type McpServerType = (typeof McpServerType)[keyof typeof McpServerType];

export const PermissionEffect = {
  Allow: "allow",
  Deny: "deny",
  Ask: "ask",
} as const;
export type PermissionEffect = (typeof PermissionEffect)[keyof typeof PermissionEffect];
export const permissionEffects = [
  PermissionEffect.Allow,
  PermissionEffect.Deny,
  PermissionEffect.Ask,
] as const;

export const NativeAction = {
  Edit: "edit",
  Shell: "shell",
  Subagent: "subagent",
} as const;
export type NativeAction = (typeof NativeAction)[keyof typeof NativeAction];

export const LegacyAction = {
  Write: "write",
  Patch: "patch",
  ApplyPatch: "apply_patch",
  Task: "task",
  Bash: "bash",
} as const;
export type LegacyAction = (typeof LegacyAction)[keyof typeof LegacyAction];

export const SessionEventType = {
  Created: "session.created",
  Deleted: "session.deleted",
  Renamed: "session.renamed",
  Moved: "session.moved",
  AgentSelected: "session.agent.selected",
  ModelSelected: "session.model.selected",
  MetadataUpdated: "session.metadata.updated",
  Permissions: "session.permissions",
  Archived: "session.archived",
  Unarchived: "session.unarchived",
  ExecutionStarted: "session.execution.started",
  ExecutionSucceeded: "session.execution.succeeded",
  ExecutionFailed: "session.execution.failed",
  ExecutionInterrupted: "session.execution.interrupted",
  InboxDelivered: "session.inbox.delivered",
  Synthetic: "session.synthetic",
  StepStarted: "session.step.started",
  StepEnded: "session.step.ended",
  StepFailed: "session.step.failed",
  TextDelta: "session.text.delta",
  TextEnded: "session.text.ended",
  ReasoningDelta: "session.reasoning.delta",
  ReasoningEnded: "session.reasoning.ended",
  ToolCalled: "session.tool.called",
  ToolProgress: "session.tool.progress",
  ToolSuccess: "session.tool.success",
  ToolFailed: "session.tool.failed",
  RetryScheduled: "session.retry.scheduled",
  CompactionEnded: "session.compaction.ended",
  CompactionFailed: "session.compaction.failed",
} as const satisfies Record<string, Exclude<OpenCodeEvent["type"], "server.connected">>;
export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];

export const SessionRequestKind = {
  Primary: "primary",
  Compaction: "compaction",
  Title: "title",
  Generate: "generate",
} as const satisfies Record<string, SessionModelResolve["kind"]>;
export type SessionRequestKind = (typeof SessionRequestKind)[keyof typeof SessionRequestKind];

export const SessionOperation = {
  Abort: "abort",
  Message: "message",
  PromptAsync: "prompt_async",
  Summarize: "summarize",
  Status: "status",
  Todo: "todo",
} as const;
export type SessionOperation = (typeof SessionOperation)[keyof typeof SessionOperation];

export const PromptFileSourceKind = {
  Inline: "inline",
  Uri: "uri",
} as const satisfies Record<string, PromptFileSource["type"]>;
export type PromptFileSourceKind = (typeof PromptFileSourceKind)[keyof typeof PromptFileSourceKind];

export const LegacyEventType = {
  SessionCreated: "session.created",
  SessionUpdated: "session.updated",
  SessionDeleted: "session.deleted",
  SessionStatus: "session.status",
  SessionError: "session.error",
  SessionIdle: "session.idle",
  SessionCompacted: "session.compacted",
  MessageUpdated: "message.updated",
  MessagePartUpdated: "message.part.updated",
  TodoUpdated: "todo.updated",
} as const satisfies Record<string, Event["type"]>;
export type LegacyEventType = (typeof LegacyEventType)[keyof typeof LegacyEventType];

export const NativeTool = {
  TodoWrite: "todowrite",
} as const;
export type NativeTool = (typeof NativeTool)[keyof typeof NativeTool];

export const TodoStatus = {
  Pending: "pending",
  InProgress: "in_progress",
  Completed: "completed",
  Cancelled: "cancelled",
} as const;
export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];
export const todoStatuses = [
  TodoStatus.Pending,
  TodoStatus.InProgress,
  TodoStatus.Completed,
  TodoStatus.Cancelled,
] as const;

export const TodoPriority = {
  High: "high",
  Medium: "medium",
  Low: "low",
} as const;
export type TodoPriority = (typeof TodoPriority)[keyof typeof TodoPriority];

type ToastVariantValue = NonNullable<TuiShowToastData["body"]>["variant"];
export const ToastVariant = {
  Info: "info",
  Success: "success",
  Warning: "warning",
  Error: "error",
} as const satisfies Record<string, ToastVariantValue>;
export type ToastVariant = (typeof ToastVariant)[keyof typeof ToastVariant];
export const toastVariants = [
  ToastVariant.Info,
  ToastVariant.Success,
  ToastVariant.Warning,
  ToastVariant.Error,
] as const;

export const CompactionStatus = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
} as const satisfies Record<string, SessionMessageCompaction["status"]>;
export type CompactionStatus = (typeof CompactionStatus)[keyof typeof CompactionStatus];

export const ErrorName = {
  ProviderAuth: "ProviderAuthError",
  Unknown: "UnknownError",
  OutputLength: "MessageOutputLengthError",
  Aborted: "MessageAbortedError",
  Api: "APIError",
  BadRequest: "BadRequest",
  Abort: "AbortError",
  Bridge: "BridgeError",
  Compatibility: "CompatibilityError",
} as const satisfies Record<
  string,
  | NonNullable<AssistantMessage["error"]>["name"]
  | BadRequestError["name"]
  | "AbortError"
  | "BridgeError"
  | "CompatibilityError"
>;
export type ErrorName = (typeof ErrorName)[keyof typeof ErrorName];
