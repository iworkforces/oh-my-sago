import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import omsago from "../../../src/index.js";

export default Plugin.define({
  id: omsago.id,
  async setup(context) {
    const instance = crypto.randomUUID();
    const cleanup = await omsago.setup(context);
    const receipt = { id: omsago.id, instance, directory: context.location.directory };
    await appendFile(
      join(context.location.directory, "cleanup.jsonl"),
      `${JSON.stringify({ ...receipt, event: "setup" })}\n`,
    );
    return async () => {
      await cleanup?.();
      await appendFile(
        join(context.location.directory, "cleanup.jsonl"),
        `${JSON.stringify({ ...receipt, event: "cleanup" })}\n`,
      );
    };
  },
});
