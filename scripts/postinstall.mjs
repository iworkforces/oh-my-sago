import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const directory = join(homedir(), ".omsg");
mkdirSync(directory, { recursive: true });

try {
  writeFileSync(join(directory, "omsg.json"), "{}\n", { flag: "wx" });
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
}
