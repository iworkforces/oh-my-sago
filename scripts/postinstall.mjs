import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const directory = join(homedir(), ".omsago");
mkdirSync(directory, { recursive: true });

try {
  writeFileSync(join(directory, "omsago.json"), "{}\n", { flag: "wx" });
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
}
