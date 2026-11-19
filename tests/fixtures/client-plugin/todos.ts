import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import type { createClientBridge } from "../../../src/client/index.js";
import { ContentKind, LegacyEventType, TodoPriority } from "../../../src/enums.js";
import { EventLog, idleOf } from "./events.js";
import { fixtureTodos } from "./model.js";

type Bridge = ReturnType<typeof createClientBridge>;

export const expectedTodos = fixtureTodos.map((todo) => ({
  ...todo,
  priority: TodoPriority.Medium,
}));

async function readTodos(bridge: Bridge, id: string): Promise<unknown> {
  const todos = await bridge.input.client.session.todo({ path: { id } });
  assert.equal(todos.response.status, 200, JSON.stringify(todos.error));
  return todos.data;
}

export async function verifyTodos(context: Plugin.Context, bridge: Bridge): Promise<string> {
  const client = bridge.input.client;
  const log = new EventLog();
  await bridge.start(log.sink);
  const create = async () => {
    const response = await client.session.create({ body: { title: "client todos" } });
    assert.ok(response.data, JSON.stringify(response.error));
    return response.data.id;
  };
  const prompt = async (id: string, text: string) => {
    const mark = log.mark();
    const reply = await client.session.prompt({
      path: { id },
      body: { parts: [{ type: ContentKind.Text, text }] },
    });
    assert.ok(reply.data, JSON.stringify(reply.error));
    await log.until(idleOf(id), `idle after ${text}`, mark);
    return log.since(mark, id);
  };

  const id = await create();
  assert.deepEqual(await readTodos(bridge, id), []);
  await context.session.update({ sessionID: id, metadata: { "omsago.fixture.kept": true } });
  const written = await prompt(id, "CLIENT_TODO");
  const updates = written.filter((event) => event.type === LegacyEventType.TodoUpdated);
  assert.deepEqual(
    updates.map((event) => event.properties),
    [{ sessionID: id, todos: expectedTodos }],
  );
  const types = written.map((event) => event.type);
  assert.ok(
    types.indexOf(LegacyEventType.TodoUpdated) < types.lastIndexOf(LegacyEventType.SessionIdle),
    JSON.stringify(types),
  );
  assert.deepEqual(await readTodos(bridge, id), expectedTodos);
  const metadata = (await context.session.get({ sessionID: id })).metadata;
  assert.equal(metadata?.["omsago.fixture.kept"], true, JSON.stringify(metadata));
  // A child copies its parent's metadata natively, but starts without the parent's list.
  const child = await client.session.create({ body: { parentID: id, title: "client todo child" } });
  assert.ok(child.data, JSON.stringify(child.error));
  assert.deepEqual(await readTodos(bridge, child.data.id), []);

  const compaction = log.mark();
  const compacted = await client.session.summarize({
    path: { id },
    body: { providerID: "omsago-test", modelID: "scripted" },
  });
  assert.equal(compacted.data, true, JSON.stringify(compacted.error));
  await log.until(
    (event) => event.type === LegacyEventType.SessionCompacted && event.properties.sessionID === id,
    "session.compacted",
    compaction,
  );
  assert.deepEqual(await readTodos(bridge, id), expectedTodos);

  const invalid = await create();
  const rejected = await prompt(invalid, "CLIENT_TODO_INVALID");
  assert.ok(rejected.every((event) => event.type !== LegacyEventType.TodoUpdated));
  assert.deepEqual(await readTodos(bridge, invalid), []);
  assert.equal(
    log.since(0).filter((event) => event.type === LegacyEventType.TodoUpdated).length,
    1,
  );
  return id;
}

export async function verifyRestoredTodos(bridge: Bridge, id: string): Promise<void> {
  assert.deepEqual(await readTodos(bridge, id), expectedTodos);
}
