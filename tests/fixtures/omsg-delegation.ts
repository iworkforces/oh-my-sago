import assert from "node:assert/strict";
import { z } from "zod";
import { PartKind, SessionOutcome, ToolStateStatus } from "../../src/enums.js";
import type { cliHost } from "./cli-host.js";

const session = z.object({
  id: z.string(),
  parentID: z.string().optional(),
  outcome: z.string().optional(),
});
const content = z.object({
  type: z.string(),
  name: z.string().optional(),
  text: z.string().optional(),
  state: z
    .object({
      status: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })
    .optional(),
});
const records = z.object({
  data: z.array(z.object({ type: z.string(), content: z.array(content).optional() })),
});

export async function verifyDelegation(host: Awaited<ReturnType<typeof cliHost>>, agent: string) {
  for (const mode of ["OMSG_SYNC", "OMSG_BACKGROUND", "OMSG_FAILURE", "OMSG_CANCEL"]) {
    const parent = z.object({ data: session }).parse(
      await host.request("/api/session", {
        agent,
        model: { providerID: "omsg-test", id: "scripted" },
      }),
    ).data;
    await host.request(`/api/session/${parent.id}/prompt`, { text: mode });
    await host.request(`/api/session/${parent.id}/command`, { name: "fixture-wait", text: "" });
    const parts = records
      .parse(await host.request(`/api/session/${parent.id}/context`))
      .data.flatMap((record) => record.content ?? []);
    const task = parts.find((part) => part.type === PartKind.Tool && part.name === "task");
    assert.equal(task?.state?.status, ToolStateStatus.Completed, JSON.stringify({ mode, parts }));
    assert.ok(
      parts.some((part) => part.type === PartKind.Text && part.text === "omsg ready"),
      JSON.stringify({ mode, parts }),
    );
    const children = z
      .object({ data: z.array(session) })
      .parse(await host.request("/api/session"))
      .data.filter((child) => child.parentID === parent.id);
    assert.equal(children.length, 1, JSON.stringify({ mode, parts, children }));
    const child = children[0];
    assert.ok(child);
    await host.request(`/api/session/${child.id}/command`, { name: "fixture-wait", text: "" });
    const current = z
      .object({ data: session })
      .parse(await host.request(`/api/session/${child.id}`)).data;
    assert.equal(
      current.outcome,
      mode === "OMSG_FAILURE"
        ? SessionOutcome.Failed
        : mode === "OMSG_CANCEL"
          ? SessionOutcome.Interrupted
          : SessionOutcome.Succeeded,
    );
    const childParts = records
      .parse(await host.request(`/api/session/${child.id}/context`))
      .data.flatMap((record) => record.content ?? []);
    if (mode === "OMSG_SYNC" || mode === "OMSG_BACKGROUND")
      assert.ok(
        childParts.some((part) => part.type === PartKind.Text && part.text === "child complete"),
      );
    else
      assert.ok(
        parts.some(
          (part) =>
            part.name === (mode === "OMSG_FAILURE" ? "background_output" : "background_cancel") &&
            part.state?.status === ToolStateStatus.Completed,
        ),
      );
  }
  return {
    delegation: "passed",
    background: "passed",
    failure: "passed",
    cancellation: "passed",
  } as const;
}
