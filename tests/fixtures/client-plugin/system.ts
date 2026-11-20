import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import type { SessionRequest } from "@opencode/plugin/promise/session";

/** The entry the fixture's legacy system hook prepends to every request. */
export const systemPrefix = "system prefix";
const marker = "omsago.fixture.system";

type SystemPart = SessionRequest["system"][number];
type Registration = { readonly dispose: () => Promise<void> };

export interface SystemProbe {
  /** Marks each host system part with its own text and gives the first one a cache hint. */
  tag(): Promise<Registration>;
  /** Records each part whose mark or cache hint now sits on other text, and a prefix that is not plain. */
  check(): Promise<Registration>;
  verify(): "passed";
}

/** Native `context` hooks registered around omsago's, so they see its system transform's input and output. */
export function systemProbe(context: Plugin.Context): SystemProbe {
  let tagged = 0;
  let cached = 0;
  const moved: string[] = [];
  return {
    tag: () =>
      context.session.hook("context", (event) => {
        if (event.system.length > 0) tagged++;
        event.system = event.system.map((part, index): SystemPart => ({
          ...part,
          ...(index === 0 ? { cache: { type: "ephemeral" } } : {}),
          metadata: { ...part.metadata, [marker]: part.text },
        }));
      }),
    check: () =>
      context.session.hook("context", (event) => {
        for (const part of event.system) {
          if (part.cache !== undefined) cached++;
          const mark = part.metadata?.[marker];
          const intact =
            part.text === systemPrefix
              ? part.metadata === undefined && part.cache === undefined
              : mark === undefined
                ? part.cache === undefined
                : mark === part.text;
          if (!intact) moved.push(JSON.stringify(part));
        }
      }),
    verify() {
      assert.ok(
        tagged > 0 && cached >= tagged,
        `${cached} cached system parts in ${tagged} requests`,
      );
      assert.deepEqual(moved, []);
      return "passed";
    },
  };
}
