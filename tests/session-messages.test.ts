import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { Media } from "@opencode/ai";
import type { ContentPart, ToolCallPart, ToolResultPart } from "@opencode/ai";
import { Model } from "@opencode/plugin";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import { Session } from "@opencode/schema/session";
import type { Hooks } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import {
  ContentKind,
  MessageRole,
  PartKind,
  ToolContentKind,
  ToolResultKind,
  ToolStateStatus,
} from "../src/enums.js";
import { hideMarkers, markerMetadata, showMarkers } from "../src/session/markers.js";
import { cleanInternalPrompts, transformMessages } from "../src/session/messages.js";

function request(messages: SessionRequest["messages"]): SessionRequest {
  return {
    sessionID: Session.ID.make("ses_history"),
    model: Model.Ref.parse("omsago-test/scripted"),
    messages,
    system: [],
    options: {},
  };
}

test("a text edit and injected message retain native media, reasoning, tool results and metadata", async () => {
  const media: ContentPart = {
    type: ContentKind.Media,
    media: Media.url("https://example.invalid/image.png", { mediaType: "image/png" }),
  };
  const reasoning: ContentPart = {
    type: ContentKind.Reasoning,
    text: "private thought",
    providerMetadata: { test: { signature: "signed" } },
  };
  const call: ContentPart = {
    type: ContentKind.ToolCall,
    id: "call-1",
    name: "read_file",
    input: { path: "/fixture" },
  };
  const result: ToolResultPart = {
    type: ContentKind.ToolResult,
    id: "call-1",
    name: "read_file",
    result: { type: ToolResultKind.Text, value: "original output" },
  };
  const user = {
    id: "user-1",
    role: MessageRole.User,
    metadata: { owner: "user" },
    content: [{ type: ContentKind.Text, text: "original" }, media],
  };
  const assistant = {
    id: "assistant-1",
    role: MessageRole.Assistant,
    providerMetadata: { test: { message: "signed" } },
    content: [reasoning, call],
  };
  const tool = { id: "tool-1", role: MessageRole.Tool, content: [result] };
  const event = request([user, assistant, tool]);
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      const first = output.messages[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      const part = first.parts.find((item) => item.type === PartKind.Text);
      if (part?.type === PartKind.Text) part.text = "edited";
      output.messages.push({
        info: { ...first.info, id: "injected" },
        parts: [
          {
            id: "injected:text",
            sessionID: event.sessionID,
            messageID: "injected",
            type: PartKind.Text,
            text: "injected reminder",
          },
        ],
      });
    },
  });
  expect(event.messages[0]?.content[0]).toEqual({ type: ContentKind.Text, text: "edited" });
  expect(event.messages[0]?.content[1]).toBe(media);
  expect(event.messages[0]?.metadata).toBe(user.metadata);
  expect(event.messages[1]).toBe(assistant);
  expect(event.messages[2]).toBe(tool);
  expect(event.messages[3]).toMatchObject({
    role: MessageRole.User,
    content: [{ type: ContentKind.Text, text: "injected reminder" }],
  });
});

test("cloned legacy messages can remove history and repair a tool result without dropping its file", async () => {
  const call: ContentPart = {
    type: ContentKind.ToolCall,
    id: "call-1",
    name: "read_file",
    input: { path: "/fixture" },
  };
  const file = { type: ToolContentKind.File, uri: "file:///fixture/image.png", mime: "image/png" };
  const result: ToolResultPart = {
    type: ContentKind.ToolResult,
    id: "call-1",
    name: "read_file",
    result: {
      type: ToolResultKind.Content,
      value: [{ type: ToolContentKind.Text, text: "old output" }, file],
    },
  };
  const event = request([
    {
      id: "discard",
      role: MessageRole.User,
      content: [{ type: ContentKind.Text, text: "discard me" }],
    },
    { id: "call", role: MessageRole.Assistant, content: [call] },
    { id: "result", role: MessageRole.Tool, content: [result] },
  ]);
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      output.messages = structuredClone(output.messages).filter(
        (message) => message.info.id !== "discard",
      );
      const part = output.messages[0]?.parts[0];
      expect(part?.type).toBe(PartKind.Tool);
      if (part?.type === PartKind.Tool && part.state.status === ToolStateStatus.Completed)
        part.state.output = "repaired";
    },
  });
  expect(event.messages.map((message) => message.id)).toEqual(["call", "result"]);
  expect(event.messages[0]?.content[0]).toBe(call);
  expect(event.messages[1]?.content[0]).toMatchObject({
    type: ContentKind.ToolResult,
    result: {
      type: ToolResultKind.Content,
      value: [{ type: ToolContentKind.Text, text: "repaired" }, file],
    },
  });
  const restored = event.messages[1]?.content[0];
  expect(
    restored?.type === ContentKind.ToolResult &&
      restored.result.type === ToolResultKind.Content &&
      restored.result.value[1],
  ).toBe(file);
});

test("unrepresentable media edits fail explicitly instead of losing the asset", async () => {
  const event = request([
    {
      role: MessageRole.User,
      content: [
        {
          type: ContentKind.Media,
          media: Media.url("https://example.invalid/a.png", { mediaType: "image/png" }),
        },
      ],
    },
  ]);
  await assert.rejects(
    transformMessages(event, {
      async "experimental.chat.messages.transform"(_input, output) {
        const part = output.messages[0]?.parts[0];
        if (part?.type === PartKind.File) part.url = "https://example.invalid/b.png";
      },
    }),
    /file insertion or edit/,
  );
});

const textPart = (value: string) => ({ type: ContentKind.Text, text: value });
const readCall = (id: string, path: string): ToolCallPart => ({
  type: ContentKind.ToolCall,
  id,
  name: "read_file",
  input: { path },
});
const readResult = (id: string, value: string): ToolResultPart => ({
  type: ContentKind.ToolResult,
  id,
  name: "read_file",
  result: { type: ToolResultKind.Text, value },
});

/** Every call is answered exactly once by a tool message of its turn, and no result lacks a call. */
function expectPaired(messages: SessionRequest["messages"]): void {
  let open: string[] = [];
  for (const message of messages) {
    if (message.role === MessageRole.Assistant) {
      expect(open).toEqual([]);
      open = [];
    }
    for (const part of message.content) {
      if (part.type === ContentKind.ToolCall) open.push(part.id);
      if (part.type !== ContentKind.ToolResult) continue;
      expect(message.role).toBe(MessageRole.Tool);
      expect(open).toContain(part.id);
      open.splice(open.indexOf(part.id), 1);
    }
  }
  expect(open).toEqual([]);
}

test("a call id reused across turns shows and edits only the result of its own turn", async () => {
  const firstResult = readResult("call-1", "first output");
  const secondTool = {
    id: "tool-2",
    role: MessageRole.Tool,
    content: [readResult("call-1", "second output")],
  };
  const event = request([
    { id: "user-1", role: MessageRole.User, content: [textPart("first")] },
    { id: "assistant-1", role: MessageRole.Assistant, content: [readCall("call-1", "/first")] },
    { id: "tool-1", role: MessageRole.Tool, content: [firstResult] },
    { id: "user-2", role: MessageRole.User, content: [textPart("second")] },
    { id: "assistant-2", role: MessageRole.Assistant, content: [readCall("call-1", "/second")] },
    secondTool,
  ]);
  const shown: string[] = [];
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      for (const message of output.messages) {
        const part = message.parts[0];
        if (!message.info.id.startsWith("assistant") || part?.type !== PartKind.Tool) continue;
        if (part.state.status !== ToolStateStatus.Completed) continue;
        shown.push(part.state.output);
        if (message.info.id === "assistant-1") part.state.output = "first edited";
      }
    },
  });
  expect(shown).toEqual(["first output", "second output"]);
  expect(event.messages[2]?.content).toEqual([
    { ...firstResult, result: { type: ToolResultKind.Text, value: "first edited" } },
  ]);
  expect(event.messages[5]).toBe(secondTool);
  expectPaired(event.messages);
});

test("a hook that drops a tool message leaves every call answered", async () => {
  const assistant = {
    id: "assistant",
    role: MessageRole.Assistant,
    content: [readCall("call-1", "/answered"), readCall("call-2", "/interrupted")],
  };
  const result = readResult("call-1", "output");
  const event = request([
    { id: "user", role: MessageRole.User, content: [textPart("read both")] },
    assistant,
    { id: "tool", role: MessageRole.Tool, content: [result] },
    { id: "next", role: MessageRole.User, content: [textPart("continue")] },
  ]);
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      output.messages = output.messages.filter((message) => message.info.id !== "tool");
    },
  });
  expect(event.messages.map((message) => message.role)).toEqual([
    MessageRole.User,
    MessageRole.Assistant,
    MessageRole.Tool,
    MessageRole.Tool,
    MessageRole.User,
  ]);
  expect(event.messages[1]).toBe(assistant);
  expect(event.messages[2]?.content[0]).toBe(result);
  expect(event.messages[3]?.content).toMatchObject([
    {
      type: ContentKind.ToolResult,
      id: "call-2",
      name: "read_file",
      result: { type: ToolResultKind.Error },
    },
  ]);
  expectPaired(event.messages);
});

test("a hook that drops a tool call also drops its orphaned result", async () => {
  const kept = readCall("call-1", "/kept");
  const assistant = {
    id: "assistant",
    role: MessageRole.Assistant,
    providerMetadata: { test: { message: "signed" } },
    content: [textPart("reading"), kept, readCall("call-2", "/dropped")],
  };
  const keptTool = {
    id: "tool-1",
    role: MessageRole.Tool,
    content: [readResult("call-1", "kept")],
  };
  const event = request([
    { id: "user", role: MessageRole.User, content: [textPart("read")] },
    assistant,
    keptTool,
    { id: "tool-2", role: MessageRole.Tool, content: [readResult("call-2", "dropped")] },
  ]);
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      const record = output.messages.find((message) => message.info.id === "assistant");
      if (record === undefined) return;
      record.parts = record.parts.filter(
        (part) => part.type !== PartKind.Tool || part.callID !== "call-2",
      );
    },
  });
  expect(event.messages.map((message) => message.id)).toEqual(["user", "assistant", "tool-1"]);
  const rebuilt = event.messages[1];
  expect(rebuilt?.content).toEqual([textPart("reading"), kept]);
  expect(rebuilt?.content[1]).toBe(kept);
  expect(rebuilt?.role === MessageRole.Assistant && rebuilt.providerMetadata).toBe(
    assistant.providerMetadata,
  );
  expect(event.messages[2]).toBe(keptTool);
  expectPaired(event.messages);
});

test("hook-created tool parts restore to native names and arguments from either legacy shape", async () => {
  const event = request([
    { id: "user", role: MessageRole.User, content: [textPart("read")] },
    { id: "assistant", role: MessageRole.Assistant, content: [textPart("reading")] },
  ]);
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      const record = output.messages[1];
      if (record === undefined) return;
      const created = (callID: string, tool: string, input: Record<string, unknown>): Part => ({
        id: `created:${callID}`,
        sessionID: event.sessionID,
        messageID: record.info.id,
        type: PartKind.Tool,
        callID,
        tool,
        state: {
          status: ToolStateStatus.Completed,
          input,
          output: callID,
          title: tool,
          metadata: {},
          time: { start: 0, end: 0 },
        },
      });
      record.parts.push(
        created("legacy-name", "read", { path: "/legacy-name" }),
        created("native-name", "read_file", { filePath: "/native-name" }),
        created("legacy-shape", "read", { filePath: "/legacy-shape" }),
      );
    },
  });
  const ids = ["legacy-name", "native-name", "legacy-shape"];
  expect(event.messages[1]?.content.slice(1)).toEqual(ids.map((id) => readCall(id, `/${id}`)));
  expect(event.messages.slice(2)).toEqual(
    ids.map((id) => ({ role: MessageRole.Tool, content: [readResult(id, id)] })),
  );
  expectPaired(event.messages);
});

test("an edited reasoning part is sent without its signature while unchanged reasoning stays native", async () => {
  const kept: ContentPart = {
    type: ContentKind.Reasoning,
    text: "kept thought",
    providerMetadata: { test: { signature: "kept" } },
  };
  const event = request([
    { id: "user", role: MessageRole.User, content: [textPart("think")] },
    {
      id: "assistant",
      role: MessageRole.Assistant,
      content: [
        {
          type: ContentKind.Reasoning,
          text: "first thought",
          encrypted: "opaque",
          providerMetadata: { test: { signature: "first" } },
        },
        kept,
      ],
    },
  ]);
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      const part = output.messages[1]?.parts[0];
      if (part?.type === PartKind.Reasoning) part.text = "edited thought";
    },
  });
  expect(event.messages[1]?.content).toEqual([
    { type: ContentKind.Reasoning, text: "edited thought" },
    kept,
  ]);
  expect(event.messages[1]?.content[1]).toBe(kept);
});

test("a duplicated record does not reuse its native message identity or provider metadata", async () => {
  const assistant = {
    id: "assistant",
    role: MessageRole.Assistant,
    providerMetadata: { test: { itemId: "item-1" } },
    content: [textPart("answer")],
  };
  const event = request([
    { id: "user", role: MessageRole.User, content: [textPart("ask")] },
    assistant,
  ]);
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      const record = output.messages[1];
      if (record !== undefined) output.messages.push(structuredClone(record));
    },
  });
  expect(event.messages[1]).toBe(assistant);
  expect(event.messages[2]).toEqual({ role: MessageRole.Assistant, content: assistant.content });
});

test("a transform that throws leaves the request untouched", async () => {
  const messages: SessionRequest["messages"] = [
    { id: "user", role: MessageRole.User, content: [textPart("read")] },
    { id: "assistant", role: MessageRole.Assistant, content: [readCall("call-1", "/fixture")] },
    { id: "tool", role: MessageRole.Tool, content: [readResult("call-1", "output")] },
  ];
  const snapshot = structuredClone(messages);
  const failures: NonNullable<Hooks["experimental.chat.messages.transform"]>[] = [
    async (_input, output) => {
      output.messages = output.messages.filter((message) => message.info.id !== "tool");
      throw new Error("hook failed");
    },
    async (_input, output) => {
      const part = output.messages[1]?.parts[0];
      if (part?.type === PartKind.Tool) part.tool = "renamed";
    },
  ];
  for (const failure of failures) {
    const event = request(messages);
    await assert.rejects(
      transformMessages(event, { "experimental.chat.messages.transform": failure }),
    );
    expect(event.messages).toBe(messages);
    expect(event.messages).toEqual(snapshot);
  }
});

const done = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n</system-reminder>";
const initiator = "<!-- OMO_INTERNAL_INITIATOR -->";
const noReply = "<!-- OMO_INTERNAL_NOREPLY -->";

test("the model gets OmO notices without markers or a reminder repeated within the turn", () => {
  const next = "<system-reminder>\n[BACKGROUND TASK ERROR]\n</system-reminder>";
  const deposit = {
    id: "deposit",
    role: MessageRole.User,
    metadata: { owner: "omo" },
    content: [textPart(`${done}\n${initiator}\n\n${noReply}`)],
  };
  const reply = {
    id: "reply",
    role: MessageRole.User,
    content: [textPart(`${done}\n${initiator}`)],
  };
  const merged = {
    id: "merged",
    role: MessageRole.User,
    content: [textPart(`${done}\n\n${next}`)],
  };
  const assistant = { id: "assistant", role: MessageRole.Assistant, content: [textPart("ack")] };
  const repeated = { id: "repeated", role: MessageRole.User, content: [textPart(done)] };
  const messages = cleanInternalPrompts([deposit, reply, merged, assistant, repeated]);
  expect(messages).toEqual([
    { ...deposit, content: [textPart(done)] },
    { ...merged, content: [textPart(next)] },
    assistant,
    repeated,
  ]);
  expect(messages[2]).toBe(assistant);
  expect(messages[3]).toBe(repeated);
});

test("the model gets an OmO notice it read in an earlier turn again only when OmO asks with it alone", () => {
  const next = "<system-reminder>\n[BACKGROUND TASK ERROR]\n</system-reminder>";
  const metadata = { [markerMetadata]: [initiator, noReply] };
  const notice = { id: "notice", role: MessageRole.User, metadata, content: [textPart(done)] };
  const read = { id: "read", role: MessageRole.Assistant, content: [textPart("noted")] };
  const merged = {
    id: "merged",
    role: MessageRole.User,
    metadata,
    content: [textPart(`${done}\n\n${next}`)],
  };
  const woken = { id: "woken", role: MessageRole.User, content: [textPart("<subagent />")] };
  const idle = { id: "idle", role: MessageRole.Assistant, content: [textPart("waiting")] };
  const asked = { id: "asked", role: MessageRole.User, metadata, content: [textPart(done)] };
  const answered = { id: "answered", role: MessageRole.Assistant, content: [textPart("again")] };
  const quoted = {
    id: "quoted",
    role: MessageRole.User,
    content: [textPart(`Why twice?\n${done}`)],
  };
  const messages = cleanInternalPrompts([
    notice,
    read,
    merged,
    woken,
    idle,
    asked,
    answered,
    quoted,
  ]);
  expect(messages).toEqual([
    notice,
    read,
    { ...merged, content: [textPart(next)] },
    woken,
    idle,
    asked,
    answered,
    quoted,
  ]);
  expect(messages[5]).toBe(asked);
  expect(messages[7]).toBe(quoted);
});

test("OmO reads back the markers a stored prompt was saved without", async () => {
  const hidden = hideMarkers(`${done}\n${initiator}\n\n${noReply}`);
  expect(hidden).toEqual({ text: done, markers: [initiator, noReply] });
  const stored = {
    id: "notice",
    role: MessageRole.User,
    metadata: { [markerMetadata]: hidden.markers },
    content: [textPart(hidden.text)],
  };
  const event = request([stored]);
  const shown: string[] = [];
  await transformMessages(event, {
    async "experimental.chat.messages.transform"(_input, output) {
      for (const part of output.messages.flatMap((message) => message.parts))
        if (part.type === PartKind.Text) shown.push(part.text);
    },
  });
  expect(shown).toEqual([showMarkers(hidden.text, stored.metadata)]);
  expect(shown[0]).toContain(initiator);
  expect(shown[0]).toContain(noReply);
  expect(event.messages[0]).toBe(stored);
});
