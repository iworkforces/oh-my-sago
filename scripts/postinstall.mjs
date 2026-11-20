import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const directory = join(homedir(), ".omsago");
const seed = join(directory, "omsago.json");

// An unwritable home only costs the seed, so installing warns and carries on.
function warn(path, error) {
  const reason = error instanceof Error && "code" in error ? String(error.code) : String(error);
  console.error(`omsago: could not write ${path} (${reason})`);
}

function seedConfiguration() {
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    warn(directory, error);
    return;
  }
  try {
    writeFileSync(seed, "{}\n", { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) warn(seed, error);
  }
}

seedConfiguration();
