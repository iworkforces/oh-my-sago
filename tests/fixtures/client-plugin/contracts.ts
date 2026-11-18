import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import type { SessionInfo } from "@opencode/client";
import { SessionStatusKind } from "../../../src/enums.js";
import { createClientBridge } from "../../../src/client/index.js";

export async function verifyClient(fixture: {
  readonly context: Plugin.Context;
  readonly bridge: ReturnType<typeof createClientBridge>;
  readonly session: SessionInfo;
}) {
  const directory = fixture.context.location.directory;
  {
    const { input } = fixture.bridge;
    const [project, config, providers, agents, skills] = await Promise.all([
      input.client.project.current(),
      input.client.config.get(),
      input.client.provider.list(),
      input.client.app.agents(),
      input.client.app.skills(),
    ]);
    assert.equal(project.data?.id, fixture.context.location.project.id);
    assert.equal(project.data?.worktree, fixture.context.location.project.directory);
    assert.ok(config.data?.agent?.["build"]);
    assert.ok(providers.data?.connected.includes("omsg-test"));
    assert.equal(
      providers.data?.all.find((provider) => provider.id === "omsg-test")?.models["scripted"]
        ?.tool_call,
      true,
    );
    assert.ok(agents.data?.some((agent) => agent.name === "build"));
    assert.equal(skills.response.status, 200);
    assert.deepEqual(
      skills.data,
      (await fixture.context.skill.list()).data.map((skill) => ({
        name: skill.name,
        description: skill.description ?? "",
        location: skill.path,
        content: skill.content,
      })),
    );
    assert.equal(input.$, Bun.$);
    assert.throws(
      () =>
        input.experimental_workspace.register("test", {
          name: "test",
          description: "test",
          configure: (workspace) => workspace,
          async create() {
            assert.fail("unused workspace");
          },
          async remove() {
            assert.fail("unused workspace");
          },
          target: () => ({ type: "local", directory }),
        }),
      /unsupported/,
    );
  }
  {
    const client = fixture.bridge.input.client;
    const created = await client.session.create({
      body: { parentID: fixture.session.id, title: "child" },
    });
    if (created.data === undefined) throw created.error;
    const id = created.data.id;
    const updated = await client.session.update({ path: { id }, body: { title: "renamed" } });
    assert.equal(updated.data?.title, "renamed");
    assert.equal((await client.session.get({ path: { id } })).data?.parentID, fixture.session.id);
    assert.ok((await client.session.list()).data?.some((session) => session.id === id));
    assert.deepEqual((await client.session.status()).data?.[id], { type: SessionStatusKind.Idle });
    const todo = await client.session.todo({ path: { id } });
    assert.equal(todo.response.status, 501);
    assert.equal(todo.data, undefined);
    assert.equal((await client.session.delete({ path: { id } })).data, true);
    assert.equal(
      (await fixture.context.session.list({ directory })).data.some((session) => session.id === id),
      false,
    );
  }
  {
    const calls: Array<{ cursor: string | undefined; signal: AbortSignal | undefined }> = [];
    const context = {
      ...fixture.context,
      session: {
        ...fixture.context.session,
        async list(
          input?: Parameters<typeof fixture.context.session.list>[0],
          options?: Parameters<typeof fixture.context.session.list>[1],
        ) {
          calls.push({ cursor: input?.cursor, signal: options?.signal });
          return input?.cursor === "page-two"
            ? { data: [{ ...fixture.session, id: "second" }], cursor: {} }
            : { data: [fixture.session], cursor: { next: "page-two" } };
        },
      },
    };
    const bridge = createClientBridge(context);
    try {
      const controller = new AbortController();
      const sessions = await bridge.input.client.session.list({ signal: controller.signal });
      assert.deepEqual(
        sessions.data?.map((session) => session.id),
        [fixture.session.id, "second"],
      );
      assert.deepEqual(
        calls.map((call) => call.cursor),
        [undefined, "page-two"],
      );
      controller.abort();
      assert.ok(calls.every((call) => call.signal?.aborted));
    } finally {
      await bridge.dispose();
    }
  }
  return { discovery: "passed", sessions: "passed", pagination: "passed" } as const;
}
