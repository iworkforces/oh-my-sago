import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { createClientBridge } from "../../../src/client/index.js";
import {
  CompactionStatus,
  ContentKind,
  ErrorName,
  LegacyEventType,
  MessageRole,
  PartKind,
  RecordType,
  SessionOutcome,
  ToolStateStatus,
} from "../../../src/enums.js";

export async function verifyTurns(
  context: Plugin.Context,
  bridge: ReturnType<typeof createClientBridge>,
  started: Promise<void>,
) {
  const client = bridge.input.client;
  const eventError = Promise.withResolvers<Event>();
  await bridge.start({
    async event({ event }) {
      if (event.type === LegacyEventType.SessionError) eventError.resolve(event);
    },
  });
  const create = async () => {
    const response = await client.session.create({ body: { title: "client turn" } });
    assert.ok(response.data, JSON.stringify(response.error));
    return response.data;
  };
  const success = await create();
  const prompt = {
    parts: [{ type: ContentKind.Text, text: "CLIENT_READ" }],
    system: "fixture-system",
    maxOutputTokens: 99,
  };
  const reply = await client.session.prompt({ path: { id: success.id }, body: prompt });
  assert.ok(reply.data, JSON.stringify(reply.error));
  assert.ok(
    reply.data.parts.some(
      (part) => part.type === PartKind.Text && part.text === "client boundary reply",
    ),
    JSON.stringify(reply.data),
  );
  const history = await client.session.messages({ path: { id: success.id } });
  const read = history.data
    ?.flatMap((message) => message.parts)
    .find((part) => part.type === PartKind.Tool);
  assert.equal(read?.type, PartKind.Tool);
  assert.equal(read.tool, "read");
  assert.equal(read.state.status, ToolStateStatus.Completed, JSON.stringify(read));
  assert.equal(read.state.input["filePath"], "client.txt");
  assert.ok(
    read.state.status === ToolStateStatus.Completed &&
      read.state.output.includes("client fixture content"),
  );

  const compacted = await client.session.summarize({
    path: { id: success.id },
    body: { providerID: "omsg-test", modelID: "scripted" },
  });
  assert.equal(compacted.data, true, JSON.stringify(compacted.error));
  const compactedHistory = await context.session.context({ sessionID: success.id });
  assert.ok(
    compactedHistory.some(
      (record) =>
        record.type === RecordType.Compaction &&
        record.status === CompactionStatus.Completed &&
        record.summary?.includes("fixture summary"),
    ),
  );
  const invalid = await create();
  const invalidPrompt = {
    ...prompt,
    parts: [{ type: ContentKind.Text, text: "CLIENT_READ CLIENT_COMPACTION_FAILURE" }],
  };
  assert.ok((await client.session.prompt({ path: { id: invalid.id }, body: invalidPrompt })).data);
  const rejected = await client.session.summarize({
    path: { id: invalid.id },
    body: { providerID: "omsg-test", modelID: "scripted" },
  });
  assert.equal(rejected.response.status, 500);
  assert.match(JSON.stringify(rejected.error), /summary did not match the required template/);

  const failed = await create();
  await client.session.prompt({
    path: { id: failed.id },
    body: { parts: [{ type: ContentKind.Text, text: "CLIENT_FAILURE" }] },
  });
  const errors = await client.session.messages({ path: { id: failed.id } });
  assert.ok(
    errors.data?.some(
      (message) =>
        message.info.role === MessageRole.Assistant &&
        typeof message.info.error?.data["message"] === "string" &&
        message.info.error.data["message"].includes("scripted model failure"),
    ),
  );
  const observed = await eventError.promise;
  assert.ok(
    observed.type === LegacyEventType.SessionError && observed.properties.sessionID === failed.id,
  );

  const cancelled = await create();
  const queued = await client.session.promptAsync({
    path: { id: cancelled.id },
    body: { parts: [{ type: ContentKind.Text, text: "CLIENT_CANCEL" }] },
  });
  assert.equal(queued.response.status, 204);
  await started;
  assert.equal((await client.session.abort({ path: { id: cancelled.id } })).data, true);
  await context.session.wait({ sessionID: cancelled.id });
  assert.equal(
    (await context.session.get({ sessionID: cancelled.id })).outcome,
    SessionOutcome.Interrupted,
  );
  const interrupted = await client.session.messages({ path: { id: cancelled.id } });
  assert.ok(
    interrupted.data?.some(
      (message) =>
        message.info.role === MessageRole.Assistant &&
        message.info.error?.name === ErrorName.Aborted,
    ),
  );
  return {
    turns: "passed",
    errors: "passed",
    cancellation: "passed",
    events: "passed",
    compaction: "passed",
  } as const;
}
