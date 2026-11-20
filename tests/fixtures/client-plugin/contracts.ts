import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import type { SessionInfo } from "@opencode/client";
import { z } from "zod";
import { ErrorName, SessionStatusKind, ToastVariant } from "../../../src/enums.js";
import { createClientBridge } from "../../../src/client/index.js";

const notFoundBody = z.strictObject({
  name: z.literal(ErrorName.NotFound),
  data: z.strictObject({ message: z.string() }),
});

export const fixtureToast = {
  title: "fixture title",
  message: "fixture toast",
  variant: ToastVariant.Warning,
  duration: 1234,
} as const;

export async function verifyClient(fixture: {
  readonly context: Plugin.Context;
  readonly bridge: ReturnType<typeof createClientBridge>;
  readonly session: SessionInfo;
}): Promise<
  Readonly<Record<"discovery" | "sessions" | "notFound" | "pagination" | "toasts", "passed">>
> {
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
    assert.ok(config.data?.agent?.["build"] !== undefined);
    assert.ok(providers.data?.connected.includes("omsago-test") === true);
    assert.equal(
      providers.data?.all.find((provider) => provider.id === "omsago-test")?.models["scripted"]
        ?.tool_call,
      true,
    );
    assert.ok(agents.data?.some((agent) => agent.name === "build") === true);
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
    assert.throws(() => {
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
      });
    }, /unsupported/);
  }
  {
    const client = fixture.bridge.input.client;
    const created = await client.session.create({
      body: { parentID: fixture.session.id, title: "child" },
    });
    if (created.data === undefined) throw new Error(JSON.stringify(created.error));
    const id = created.data.id;
    const updated = await client.session.update({ path: { id }, body: { title: "renamed" } });
    assert.equal(updated.data?.title, "renamed");
    assert.equal((await client.session.get({ path: { id } })).data?.parentID, fixture.session.id);
    assert.ok((await client.session.list()).data?.some((session) => session.id === id) === true);
    assert.deepEqual((await client.session.status()).data?.[id], { type: SessionStatusKind.Idle });
    const todo = await client.session.todo({ path: { id } });
    assert.equal(todo.response.status, 200);
    assert.deepEqual(todo.data, []);
    const children = await client.session.children({ path: { id } });
    assert.equal(children.response.status, 501);
    assert.equal((await client.session.delete({ path: { id } })).data, true);
    assert.equal(
      (await fixture.context.session.list({ directory })).data.some((session) => session.id === id),
      false,
    );
    const missing = await Promise.all([
      client.session.get({ path: { id } }),
      client.session.update({ path: { id }, body: { title: "gone" } }),
      client.session.delete({ path: { id } }),
    ]);
    for (const { response, error } of missing) {
      assert.equal(response.status, 404, JSON.stringify(error));
      notFoundBody.parse(error);
    }
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
    const bridge = createClientBridge(context, {
      emit: () => Promise.reject(new Error("toast transport is down")),
    });
    try {
      const shown = await bridge.input.client.tui.showToast({ body: fixtureToast });
      assert.equal(shown.data, true, JSON.stringify(shown.error));
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
      assert.ok(calls.every((call) => call.signal?.aborted === true));
    } finally {
      await bridge.close();
    }
  }
  {
    const tui = fixture.bridge.input.client.tui;
    const shown = await tui.showToast({ body: fixtureToast });
    assert.equal(shown.response.status, 200);
    assert.equal(shown.data, true);
    const invalid = await tui.showToast();
    assert.equal(invalid.response.status, 400);
    assert.equal((await tui.openHelp()).response.status, 501);
  }
  return {
    discovery: "passed",
    sessions: "passed",
    notFound: "passed",
    pagination: "passed",
    toasts: "passed",
  } as const;
}
