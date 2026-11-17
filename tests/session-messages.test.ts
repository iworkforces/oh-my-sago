import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { Media } from "@opencode/ai";
import type { ContentPart, ToolResultPart } from "@opencode/ai";
import { Model } from "@opencode/plugin";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import { Session } from "@opencode/schema/session";
import { transformMessages } from "../src/session/messages.js";

function request(messages: SessionRequest["messages"]): SessionRequest {
  return { sessionID: Session.ID.make("ses_history"), model: Model.Ref.parse("omsg-test/scripted"), messages, system: [], options: {} };
}

test("a text edit and injected message retain native media, reasoning, tool results and metadata", async () => {
  const media: ContentPart = { type: "media", media: Media.url("https://example.invalid/image.png", { mediaType: "image/png" }) };
  const reasoning: ContentPart = { type: "reasoning", text: "private thought", providerMetadata: { test: { signature: "signed" } } };
  const call: ContentPart = { type: "tool-call", id: "call-1", name: "read_file", input: { path: "/fixture" } };
  const result: ToolResultPart = { type: "tool-result", id: "call-1", name: "read_file", result: { type: "text", value: "original output" } };
  const user = { id: "user-1", role: "user" as const, metadata: { owner: "user" }, content: [{ type: "text" as const, text: "original" }, media] };
  const assistant = { id: "assistant-1", role: "assistant" as const, providerMetadata: { test: { message: "signed" } }, content: [reasoning, call] };
  const tool = { id: "tool-1", role: "tool" as const, content: [result] };
  const event = request([user, assistant, tool]);
  await transformMessages(event, { async "experimental.chat.messages.transform"(_input, output) {
    const first = output.messages[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const part = first.parts.find((item) => item.type === "text");
    if (part?.type === "text") part.text = "edited";
    output.messages.push({ info: { ...first.info, id: "injected" }, parts: [{ id: "injected:text", sessionID: event.sessionID, messageID: "injected", type: "text", text: "injected reminder" }] });
  } });
  expect(event.messages[0]?.content[0]).toEqual({ type: "text", text: "edited" });
  expect(event.messages[0]?.content[1]).toBe(media);
  expect(event.messages[0]?.metadata).toBe(user.metadata);
  expect(event.messages[1]).toBe(assistant);
  expect(event.messages[2]).toBe(tool);
  expect(event.messages[3]).toMatchObject({ role: "user", content: [{ type: "text", text: "injected reminder" }] });
});

test("cloned legacy messages can remove history and repair a tool result without dropping its file", async () => {
  const call: ContentPart = { type: "tool-call", id: "call-1", name: "read_file", input: { path: "/fixture" } };
  const file = { type: "file" as const, uri: "file:///fixture/image.png", mime: "image/png" };
  const result: ToolResultPart = { type: "tool-result", id: "call-1", name: "read_file", result: { type: "content", value: [{ type: "text", text: "old output" }, file] } };
  const event = request([{ id: "discard", role: "user", content: [{ type: "text", text: "discard me" }] },
    { id: "call", role: "assistant", content: [call] }, { id: "result", role: "tool", content: [result] }]);
  await transformMessages(event, { async "experimental.chat.messages.transform"(_input, output) {
    output.messages = structuredClone(output.messages).filter((message) => message.info.id !== "discard");
    const part = output.messages[0]?.parts[0];
    expect(part?.type).toBe("tool");
    if (part?.type === "tool" && part.state.status === "completed") part.state.output = "repaired";
  } });
  expect(event.messages.map((message) => message.id)).toEqual(["call", "result"]);
  expect(event.messages[0]?.content[0]).toBe(call);
  expect(event.messages[1]?.content[0]).toMatchObject({ type: "tool-result", result: { type: "content", value: [{ type: "text", text: "repaired" }, file] } });
  const restored = event.messages[1]?.content[0];
  expect(restored?.type === "tool-result" && restored.result.type === "content" && restored.result.value[1]).toBe(file);
});

test("unrepresentable media edits fail explicitly instead of losing the asset", async () => {
  const event = request([{ role: "user", content: [{ type: "media", media: Media.url("https://example.invalid/a.png", { mediaType: "image/png" }) }] }]);
  await assert.rejects(transformMessages(event, { async "experimental.chat.messages.transform"(_input, output) {
    const part = output.messages[0]?.parts[0];
    if (part?.type === "file") part.url = "https://example.invalid/b.png";
  } }), /file insertion or edit/);
});
