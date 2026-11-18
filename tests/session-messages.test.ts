import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { Media } from "@opencode/ai";
import type { ContentPart, ToolResultPart } from "@opencode/ai";
import { Model } from "@opencode/plugin";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import { Session } from "@opencode/schema/session";
import {
  ContentKind,
  MessageRole,
  PartKind,
  ToolContentKind,
  ToolResultKind,
  ToolStateStatus,
} from "../src/enums.js";
import { transformMessages } from "../src/session/messages.js";

function request(messages: SessionRequest["messages"]): SessionRequest {
  return {
    sessionID: Session.ID.make("ses_history"),
    model: Model.Ref.parse("omsg-test/scripted"),
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
