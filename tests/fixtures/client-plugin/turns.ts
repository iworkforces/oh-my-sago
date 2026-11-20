import assert from "node:assert/strict";
import type { OpenCodeEvent } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import type { LegacyEvent } from "../../../src/client/events.js";
import { createClientBridge } from "../../../src/client/index.js";
import { clientMetadata } from "../../../src/client/state.js";
import {
  CompactionStatus,
  ContentKind,
  ErrorName,
  LegacyEventType,
  MessageRole,
  NativeAction,
  PartKind,
  PermissionEffect,
  RecordType,
  SessionEventType,
  SessionOutcome,
  SessionStatusKind,
  ToolStateStatus,
} from "../../../src/enums.js";
import { EventLog, compactionOf, idleOf } from "./events.js";
import { backgroundRelease, type ClientModel } from "./model.js";

type Scenario =
  | "turns"
  | "errors"
  | "cancellation"
  | "promptAbort"
  | "events"
  | "compaction"
  | "compactionCorrelation"
  | "compactionEvents"
  | "retry"
  | "variants"
  | "queuedOverrides"
  | "overridesAfterFailure"
  | "rejectedSwitch"
  | "backgroundWait";

/**
 * Relays a subscription, slipping in a `session.compaction.ended` that no compaction of ours
 * started, just ahead of the session's first compaction event.
 */
async function* withForeignEnd<Event extends OpenCodeEvent>(
  events: AsyncIterable<Event>,
  types: ReadonlyArray<string> | undefined,
  sessionID: string,
  injected: () => void,
): AsyncGenerator<Event, void> {
  const selected = (event: OpenCodeEvent): event is Event =>
    types === undefined || types.includes(event.type);
  let pending = true;
  for await (const event of events) {
    const native: OpenCodeEvent = event;
    if (
      pending &&
      (native.type === SessionEventType.CompactionStarted ||
        native.type === SessionEventType.CompactionFailed) &&
      native.data.sessionID === sessionID
    ) {
      pending = false;
      const foreign = {
        id: native.id,
        created: native.created,
        durable: native.durable,
        type: SessionEventType.CompactionEnded,
        data: { sessionID: native.data.sessionID, reason: native.data.reason, text: "foreign" },
      } satisfies OpenCodeEvent;
      if (selected(foreign)) {
        injected();
        yield foreign;
      }
    }
    yield event;
  }
}

const compactionTypes: ReadonlySet<string> = new Set([
  LegacyEventType.SessionCompactionStarted,
  LegacyEventType.SessionCompactionFailed,
  LegacyEventType.SessionCompacted,
]);

export function settledOrder(events: readonly LegacyEvent[]): string[] {
  const types = events.map((event) =>
    event.type === LegacyEventType.SessionStatus
      ? `${event.type}:${event.properties.status.type}`
      : event.type,
  );
  const idle = types.lastIndexOf(LegacyEventType.SessionIdle);
  const status = types.lastIndexOf(`${LegacyEventType.SessionStatus}:${SessionStatusKind.Idle}`);
  assert.ok(status >= 0 && status < idle, JSON.stringify(types));
  const updates: string[] = [LegacyEventType.MessageUpdated, LegacyEventType.MessagePartUpdated];
  assert.ok(
    types.slice(idle + 1).every((type) => !updates.includes(type)),
    `message updates followed session.idle: ${JSON.stringify(types)}`,
  );
  return types;
}

export async function verifyTurns(
  context: Plugin.Context,
  bridge: ReturnType<typeof createClientBridge>,
  model: ClientModel,
): Promise<Readonly<Record<Scenario, "passed">>> {
  const client = bridge.input.client;
  const probes = new Map<string, unknown>();
  const rejectErrorsOf = new Set<string>();
  const log = new EventLog(async (event) => {
    if (
      event.type === LegacyEventType.SessionError &&
      rejectErrorsOf.has(event.properties.sessionID ?? "")
    )
      throw new Error("fixture event handler failure");
    if (
      event.type === LegacyEventType.SessionStatus &&
      event.properties.status.type === SessionStatusKind.Retry
    )
      probes.set(
        event.properties.sessionID,
        (await client.session.status()).data?.[event.properties.sessionID],
      );
  });
  await bridge.start(log.sink);
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
  const toolLoop = log.mark();
  const reply = await client.session.prompt({ path: { id: success.id }, body: prompt });
  assert.ok(reply.data, JSON.stringify(reply.error));
  await log.until(idleOf(success.id), "idle after a tool loop", toolLoop);
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

  const compaction = log.mark();
  const compacted = await client.session.summarize({
    path: { id: success.id },
    body: { providerID: "omsago-test", modelID: "scripted" },
  });
  assert.equal(compacted.data, true, JSON.stringify(compacted.error));
  await log.until(
    (event) =>
      event.type === LegacyEventType.SessionCompacted && event.properties.sessionID === success.id,
    "session.compacted",
    compaction,
  );
  await log.until(idleOf(success.id), "idle after compaction", compaction);
  const lifecycle: string[] = [
    LegacyEventType.SessionStatus,
    LegacyEventType.SessionCompacted,
    LegacyEventType.SessionIdle,
  ];
  assert.deepEqual(
    settledOrder(log.since(compaction, success.id)).filter((type) =>
      lifecycle.some((prefix) => type.startsWith(prefix)),
    ),
    [
      `${LegacyEventType.SessionStatus}:${SessionStatusKind.Busy}`,
      LegacyEventType.SessionCompacted,
      `${LegacyEventType.SessionStatus}:${SessionStatusKind.Idle}`,
      LegacyEventType.SessionIdle,
    ],
  );
  assert.deepEqual(
    log
      .since(compaction, success.id)
      .map((event) => event.type)
      .filter((type) => compactionTypes.has(type)),
    [LegacyEventType.SessionCompactionStarted, LegacyEventType.SessionCompacted],
  );
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
  const declined = log.mark();
  const rejected = await client.session.summarize({
    path: { id: invalid.id },
    body: { providerID: "omsago-test", modelID: "scripted" },
  });
  assert.equal(rejected.response.status, 500);
  assert.match(JSON.stringify(rejected.error), /summary did not match the required template/);
  await log.until(
    compactionOf(LegacyEventType.SessionCompactionFailed, invalid.id),
    "session.compaction.failed",
    declined,
  );
  assert.deepEqual(
    log.since(declined, invalid.id).filter((event) => compactionTypes.has(event.type)),
    [
      { type: LegacyEventType.SessionCompactionStarted, properties: { sessionID: invalid.id } },
      { type: LegacyEventType.SessionCompactionFailed, properties: { sessionID: invalid.id } },
    ],
  );

  const raced = await create();
  assert.ok((await client.session.prompt({ path: { id: raced.id }, body: invalidPrompt })).data);
  let foreignEnds = 0;
  const racing = createClientBridge(
    {
      ...context,
      event: {
        subscribe: (options) =>
          withForeignEnd(context.event.subscribe(options), options?.types, raced.id, () => {
            foreignEnds++;
          }),
      },
    },
    { emit: () => Promise.resolve() },
  );
  try {
    const correlated = await racing.input.client.session.summarize({
      path: { id: raced.id },
      body: { providerID: "omsago-test", modelID: "scripted" },
    });
    assert.equal(correlated.response.status, 500, JSON.stringify(correlated.data));
    assert.match(JSON.stringify(correlated.error), /summary did not match the required template/);
    assert.equal(foreignEnds, 1);
  } finally {
    await racing.close();
  }

  const failed = await create();
  rejectErrorsOf.add(failed.id);
  const failure = log.mark();
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
    ) === true,
  );
  await log.until(idleOf(failed.id), "idle after a failed turn", failure);
  const failedOrder = settledOrder(log.since(failure, failed.id));
  assert.ok(
    failedOrder.indexOf(LegacyEventType.SessionError) <
      failedOrder.lastIndexOf(LegacyEventType.SessionIdle),
  );

  const cancelled = await create();
  const interruption = log.mark();
  const started = model.blocked();
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
    ) === true,
  );
  await log.until(idleOf(cancelled.id), "idle after an interrupted turn", interruption);
  const interruptedOrder = settledOrder(log.since(interruption, cancelled.id));
  assert.ok(interruptedOrder.includes(LegacyEventType.SessionError));

  const abandoned = await create();
  const caller = new AbortController();
  const blocked = model.blocked();
  const waiting = client.session.prompt({
    path: { id: abandoned.id },
    body: { parts: [{ type: ContentKind.Text, text: "CLIENT_CANCEL" }] },
    signal: caller.signal,
  });
  await blocked;
  const reason = new Error("fixture caller gave up");
  caller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  assert.deepEqual((await client.session.status()).data?.[abandoned.id], {
    type: SessionStatusKind.Busy,
  });
  const stopping = log.mark();
  assert.equal((await client.session.abort({ path: { id: abandoned.id } })).data, true);
  await log.until(idleOf(abandoned.id), "idle after interrupting an abandoned prompt", stopping);
  assert.equal(
    (await context.session.get({ sessionID: abandoned.id })).outcome,
    SessionOutcome.Interrupted,
  );

  const retried = await create();
  const retry = log.mark();
  const retryReply = await client.session.prompt({
    path: { id: retried.id },
    body: { parts: [{ type: ContentKind.Text, text: "CLIENT_RETRY" }] },
  });
  assert.ok(retryReply.data, JSON.stringify(retryReply.error));
  await log.until(idleOf(retried.id), "idle after a retried turn", retry);
  const retryEvents = log.since(retry, retried.id);
  const scheduled = retryEvents.find(
    (event) =>
      event.type === LegacyEventType.SessionStatus &&
      event.properties.status.type === SessionStatusKind.Retry,
  );
  assert.ok(scheduled?.type === LegacyEventType.SessionStatus, JSON.stringify(retryEvents));
  const status = scheduled.properties.status;
  assert.ok(status.type === SessionStatusKind.Retry);
  assert.match(status.message, /scripted capacity failure/);
  assert.ok(status.attempt >= 1 && status.next > 0, JSON.stringify(status));
  assert.deepEqual(probes.get(retried.id), status);
  const resumed = settledOrder(retryEvents).slice(retryEvents.indexOf(scheduled) + 1);
  assert.equal(resumed[0], `${LegacyEventType.SessionStatus}:${SessionStatusKind.Busy}`);
  assert.deepEqual((await client.session.status()).data?.[retried.id], {
    type: SessionStatusKind.Idle,
  });

  const variants = await create();
  type PromptBody = NonNullable<Parameters<typeof client.session.prompt>[0]["body"]>;
  const ask = async (body: PromptBody & { readonly variant?: string }) => {
    const mark = log.mark();
    const asked = await client.session.prompt({ path: { id: variants.id }, body });
    assert.ok(asked.data, JSON.stringify(asked.error));
    await log.until(idleOf(variants.id), "idle after a variant prompt", mark);
  };
  const high = {
    variant: "high",
    system: "variant-system",
    parts: [{ type: ContentKind.Text, text: "CLIENT_VARIANT prompt" }],
  };
  await ask(high);
  assert.equal((await context.session.get({ sessionID: variants.id })).model?.variant, undefined);
  await ask({ parts: [{ type: ContentKind.Text, text: "CLIENT_VARIANT CLIENT_THINK" }] });
  const native = log.mark();
  await context.session.prompt({
    sessionID: variants.id,
    text: "CLIENT_VARIANT native",
    resume: true,
  });
  await log.until(idleOf(variants.id), "idle after a native prompt", native);
  const unknown = {
    variant: "unknown",
    parts: [{ type: ContentKind.Text, text: "CLIENT_VARIANT unknown" }],
  };
  await ask(unknown);
  assert.deepEqual(
    model.variants.map(({ variant, system }) => ({ variant, system })),
    [
      { variant: "high", system: true },
      { variant: "high", system: false },
      { variant: undefined, system: false },
      { variant: undefined, system: false },
    ],
  );
  assert.equal(
    log.since(0, success.id).filter((event) => event.type === LegacyEventType.SessionCompacted)
      .length,
    1,
  );

  /** Each `CLIENT_OVERRIDE <name>` request since `from`, by the name its latest prompt carries. */
  const overridden = (from: number) =>
    model.overrides.slice(from).map(({ prompt: latest, variant, systems }) => ({
      prompt: /CLIENT_OVERRIDE (\w+)/.exec(latest)?.[1],
      variant,
      systems,
    }));
  const text = (value: string) => [{ type: ContentKind.Text, text: value }];

  // A prompt queued before a steered one keeps its own overrides once the steered turn ran.
  const steering = await create();
  const steeringRequests = model.overrides.length;
  const hold = model.hold();
  const steered = log.mark();
  const first = await client.session.promptAsync({
    path: { id: steering.id },
    body: { system: "override-first", parts: text("CLIENT_OVERRIDE first CLIENT_HOLD") },
  });
  assert.equal(first.response.status, 204);
  await hold.entered;
  const admit = (value: string, delivery: "queue" | "steer", stored: Record<string, string>) =>
    context.session.prompt({
      sessionID: steering.id,
      text: value,
      delivery,
      resume: true,
      metadata: { [clientMetadata]: stored },
    });
  await admit("CLIENT_OVERRIDE queued", "queue", { system: "override-queued" });
  await admit("CLIENT_OVERRIDE steered", "steer", { system: "override-steered", variant: "high" });
  hold.release();
  await log.until(idleOf(steering.id), "idle after steered and queued prompts", steered);
  assert.deepEqual(overridden(steeringRequests), [
    { prompt: "first", variant: undefined, systems: ["override-first"] },
    { prompt: "steered", variant: "high", systems: ["override-steered"] },
    { prompt: "queued", variant: undefined, systems: ["override-queued"] },
  ]);

  // A failed or interrupted turn leaves nothing behind for the prompt that follows it.
  const recovering = await create();
  const recoveringRequests = model.overrides.length;
  const turn = async (body: PromptBody & { readonly variant?: string }, label: string) => {
    const mark = log.mark();
    await client.session.prompt({ path: { id: recovering.id }, body });
    await log.until(idleOf(recovering.id), label, mark);
  };
  await turn(
    {
      variant: "high",
      system: "override-failed",
      parts: text("CLIENT_OVERRIDE failed CLIENT_FAIL_ONCE"),
    },
    "idle after a failed override turn",
  );
  await turn(
    { system: "override-recovered", parts: text("CLIENT_OVERRIDE recovered") },
    "idle after the turn that followed a failure",
  );
  const held: PromptBody & { readonly variant?: string } = {
    variant: "high",
    system: "override-interrupted",
    parts: text("CLIENT_OVERRIDE interrupted CLIENT_HOLD"),
  };
  const interrupting = model.hold();
  const aborting = log.mark();
  const pending = await client.session.promptAsync({ path: { id: recovering.id }, body: held });
  assert.equal(pending.response.status, 204);
  await interrupting.entered;
  assert.equal((await client.session.abort({ path: { id: recovering.id } })).data, true);
  await log.until(idleOf(recovering.id), "idle after an interrupted override turn", aborting);
  await turn({ parts: text("CLIENT_OVERRIDE resumed") }, "idle after an interrupted turn");
  assert.deepEqual(overridden(recoveringRequests), [
    { prompt: "failed", variant: "high", systems: ["override-failed"] },
    { prompt: "recovered", variant: undefined, systems: ["override-recovered"] },
    { prompt: "interrupted", variant: "high", systems: ["override-interrupted"] },
    { prompt: "resumed", variant: undefined, systems: [] },
  ]);

  // A rejected agent or model leaves the session's selection, permissions and records unchanged.
  const guarded = await create();
  const snapshot = async () => {
    const [info, recorded] = await Promise.all([
      context.session.get({ sessionID: guarded.id }),
      context.session.context({ sessionID: guarded.id }),
    ]);
    return {
      agent: info.agent,
      model: info.model,
      permissions: info.permissions,
      records: recorded.length,
    };
  };
  const original = await snapshot();
  const location = { directory: context.location.directory };
  const otherAgent = (await context.agent.list({ location })).data.find(
    (agent) => agent.id !== original.agent,
  )?.id;
  assert.ok(otherAgent !== undefined, "the fixture host offers a second agent");
  const missingModel = { providerID: "omsago-test", modelID: "missing" };
  const rejectedBodies: PromptBody[] = [
    { agent: "fixture-missing-agent", tools: { read: false }, parts: text("CLIENT_READ") },
    { agent: otherAgent, model: missingModel, tools: { read: false }, parts: text("CLIENT_READ") },
  ];
  for (const body of rejectedBodies) {
    const refused = await client.session.prompt({ path: { id: guarded.id }, body });
    assert.equal(refused.response.status, 404, JSON.stringify(refused.error));
  }
  const unsummarized = await client.session.summarize({
    path: { id: guarded.id },
    body: missingModel,
  });
  assert.equal(unsummarized.response.status, 404, JSON.stringify(unsummarized.error));
  await assert.rejects(
    context.session.prompt({ sessionID: guarded.id, text: "CLIENT_UNKNOWN_MODEL", resume: true }),
    /Unknown model omsago-test\/missing/,
  );
  assert.deepEqual(await snapshot(), original);

  const { id: owner } = await context.session.create({
    title: "client background wait",
    location: { directory: context.location.directory },
    permissions: [{ action: NativeAction.Shell, resource: "*", effect: PermissionEffect.Allow }],
  });
  const backgrounded = log.mark();
  const firstExecution = await client.session.prompt({
    path: { id: owner },
    body: { parts: [{ type: ContentKind.Text, text: "CLIENT_BACKGROUND" }] },
  });
  assert.ok(firstExecution.data, JSON.stringify(firstExecution.error));
  // The execution ended with its shell still waiting, so the shell's notice will wake the session.
  assert.equal((await client.session.status()).data?.[owner]?.type, SessionStatusKind.Busy);
  await Bun.write(`${context.location.directory}/${backgroundRelease}`, "");
  await log.until(idleOf(owner), "idle after the background shell's notice", backgrounded);
  const replies = (await client.session.messages({ path: { id: owner } })).data
    ?.flatMap((message) => message.parts)
    .filter((part) => part.type === PartKind.Text && part.text === "client boundary reply");
  assert.equal(replies?.length, 2, JSON.stringify(replies));
  assert.equal(
    log.since(backgrounded, owner).filter((event) => event.type === LegacyEventType.SessionIdle)
      .length,
    1,
  );
  assert.equal((await client.session.status()).data?.[owner]?.type, SessionStatusKind.Idle);
  return {
    turns: "passed",
    errors: "passed",
    cancellation: "passed",
    promptAbort: "passed",
    events: "passed",
    compaction: "passed",
    compactionCorrelation: "passed",
    compactionEvents: "passed",
    retry: "passed",
    variants: "passed",
    queuedOverrides: "passed",
    overridesAfterFailure: "passed",
    rejectedSwitch: "passed",
    backgroundWait: "passed",
  } as const;
}
