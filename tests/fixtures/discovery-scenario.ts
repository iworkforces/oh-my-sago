import assert from "node:assert/strict";
import { chmod, mkdir, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PartKind, PermissionEffect, RecordType, ToolStateStatus } from "../../src/enums.js";
import { cliHost } from "./cli-host.js";

const directory = z.string().min(1).parse(process.argv[2]);
const sources = [fileURLToPath(new URL("./discovery-plugin/", import.meta.url))];
await mkdir(join(directory, ".omo"));
await Bun.write(
  join(directory, ".omo", "omo.json"),
  JSON.stringify({
    "[opencode]": {
      telemetry: false,
      model_fallback: false,
      disabled_mcps: ["websearch", "context7", "grep_app"],
      disabled_skills: ["security-research", "security-review"],
      agents: { sisyphus: { model: "omsago-test/scripted" } },
    },
  }),
);
const commandsSchema = z.object({
  data: z.array(z.object({ name: z.string(), description: z.string().optional() })),
});
const skillsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      content: z.string(),
      description: z.string().optional(),
      autoinvoke: z.boolean().optional(),
    }),
  ),
});
const contextSchema = z.object({
  data: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      content: z
        .array(
          z.object({
            type: z.string(),
            name: z.string().optional(),
            state: z.object({ status: z.string(), content: z.json().optional() }).optional(),
          }),
        )
        .optional(),
    }),
  ),
});
{
  await using host = await cliHost(directory, sources);
  await host.request("/api/model");
  const commands = commandsSchema.parse(await host.request("/api/command")).data;
  assert.ok(commands.some((command) => command.name === "discovery-wait"));
  skillsSchema.parse(await host.request("/api/skill"));
  console.error(JSON.stringify({ missingRoots: "passed", runtime: host.runtime }));
}

async function markdown(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
}
// A root user can read files with mode 000, so the unreadable-entry checks only run unprivileged.
const unprivileged = process.getuid?.() !== 0;
await using restore = new AsyncDisposableStack();
const homes = [".agents", ".opencode"];
for (const [index, root] of homes.entries()) {
  await markdown(
    join(homedir(), root, "commands", `from-${index}.md`),
    `---\ndescription: |\n  Command from ${root}\n---\n${root} argument=$ARGUMENTS first=$1`,
  );
  await markdown(join(homedir(), root, "commands", "explicit-wins.md"), `home ${root}`);
  await markdown(join(homedir(), root, "commands", "project-wins.md"), `home ${root}`);
  await markdown(
    join(homedir(), root, "skills", `skill-${index}`, "SKILL.md"),
    `---\nname: discovery-skill-${index}\ndescription: |\n  Skill from ${root}\nautoinvoke: false\n---\nRun the ${root} fixture instructions.`,
  );
  await markdown(
    join(homedir(), root, "skills", "project", "SKILL.md"),
    `---\nname: discovery-project-skill\ndescription: home ${root}\n---\nhome instructions`,
  );
}
await markdown(
  join(homedir(), ".opencode", "skills", "invalid-yaml", "SKILL.md"),
  "---\nname: discovery-invalid-yaml\ndescription: How a video is made, measured: a deep teardown.\n---\nInvalid skill frontmatter.",
);
await markdown(
  join(homedir(), ".opencode", "commands", "invalid-metadata.md"),
  "---\nmodel: false\n---\nInvalid command metadata.",
);
if (unprivileged) {
  const unreadableCommand = join(homedir(), ".opencode", "commands", "unreadable-command.md");
  const unreadableSkill = join(homedir(), ".opencode", "skills", "unreadable", "SKILL.md");
  const lockedDirectory = join(homedir(), ".opencode", "skills", "locked");
  await markdown(unreadableCommand, "Unreadable command.");
  await markdown(
    unreadableSkill,
    "---\nname: discovery-unreadable\n---\nUnreadable skill instructions.",
  );
  await markdown(
    join(lockedDirectory, "SKILL.md"),
    "---\nname: discovery-locked\n---\nLocked skill instructions.",
  );
  for (const file of [unreadableCommand, unreadableSkill]) {
    await chmod(file, 0o000);
    restore.defer(() => chmod(file, 0o644));
  }
  await chmod(lockedDirectory, 0o000);
  restore.defer(() => chmod(lockedDirectory, 0o755));
}
await markdown(join(homedir(), ".agents", "commands", "nested", "review.md"), "nested $ARGUMENTS");
await markdown(
  join(homedir(), ".opencode", "skills", "collection", "deep", "nested", "SKILL.md"),
  "---\nname: discovery-nested\ndescription: nested directory\n---\nNested instructions.",
);
const target = join(directory, "real-skill");
await markdown(
  join(target, "SKILL.md"),
  "---\nname: discovery-symlink\ndescription: linked directory\n---\nLinked instructions.",
);
await symlink(target, join(homedir(), ".opencode", "skills", "linked"));
await symlink(
  join(homedir(), ".opencode", "skills"),
  join(homedir(), ".opencode", "skills", "cycle"),
);
await symlink(join(directory, "absent"), join(homedir(), ".opencode", "skills", "broken"));
await symlink("self", join(homedir(), ".opencode", "skills", "self"));
await markdown(join(directory, "commands", "project-wins.md"), "project argument=$ARGUMENTS");
await markdown(
  join(directory, "skills", "project", "SKILL.md"),
  "---\nname: discovery-project-skill\ndescription: project skill\n---\nProject instructions.",
);
process.env["OPENCODE_CONFIG_CONTENT"] = JSON.stringify({
  commands: {
    "explicit-wins": { template: "explicit argument=$ARGUMENTS", description: "Explicit command" },
  },
});

await using host = await cliHost(directory, sources);
await host.request("/api/model");
const inventory = commandsSchema.parse(await host.request("/api/command")).data;
assert.ok(inventory.every((command) => command.name !== "invalid-metadata"));
assert.ok(inventory.every((command) => command.name !== "unreadable-command"));
console.error(
  JSON.stringify({
    commands: inventory.filter((command) =>
      /^(from-|nested\/|explicit-wins|project-wins)/.test(command.name),
    ),
  }),
);
for (const name of ["from-0", "from-1", "nested/review", "explicit-wins", "project-wins"])
  assert.ok(
    inventory.some((command) => command.name === name),
    `Missing native command: ${name}`,
  );
const skills = skillsSchema.parse(await host.request("/api/skill")).data;
assert.ok(skills.every((skill) => skill.name !== "discovery-invalid-yaml"));
assert.ok(
  skills.every(
    (skill) => skill.name !== "discovery-unreadable" && skill.name !== "discovery-locked",
  ),
);
console.error(
  JSON.stringify({ skills: skills.filter((skill) => skill.name.startsWith("discovery-")) }),
);
for (const name of [
  "discovery-skill-0",
  "discovery-skill-1",
  "discovery-nested",
  "discovery-symlink",
])
  assert.ok(
    skills.some((skill) => skill.name === name),
    `Missing native skill: ${name}`,
  );
assert.equal(
  skills.find((skill) => skill.name === "discovery-project-skill")?.description,
  "project skill",
);
assert.equal(
  skills.find((skill) => skill.name === "discovery-symlink")?.path,
  await realpath(join(target, "SKILL.md")),
);
assert.equal(skills.find((skill) => skill.name === "discovery-skill-1")?.autoinvoke, false);

async function session() {
  return z.object({ data: z.object({ id: z.string() }) }).parse(
    await host.request("/api/session", {
      location: { directory },
      agent: "build",
      model: { providerID: "omsago-test", id: "scripted" },
      permissions: [{ action: "skill", resource: "*", effect: PermissionEffect.Allow }],
    }),
  ).data;
}
for (const [name, expected] of [
  ["from-0", ".agents argument=example first=example"],
  ["from-1", ".opencode argument=example first=example"],
  ["nested/review", "nested example"],
  ["explicit-wins", "explicit argument=example"],
  ["project-wins", "project argument=example"],
] as const) {
  const current = await session();
  await host.request(`/api/session/${current.id}/command`, { name, text: "example" });
  await host.request(`/api/session/${current.id}/command`, { name: "discovery-wait", text: "" });
  const records = contextSchema.parse(
    await host.request(`/api/session/${current.id}/context`),
  ).data;
  assert.ok(
    records.some(
      (record) => record.type === RecordType.User && record.text?.includes(expected) === true,
    ),
    JSON.stringify({ name, expected, records }),
  );
}
for (const [name, content] of [
  ["discovery-skill-0", "Run the .agents fixture instructions."],
  ["discovery-skill-1", "Run the .opencode fixture instructions."],
  ["discovery-nested", "Nested instructions."],
  ["discovery-symlink", "Linked instructions."],
] as const) {
  const current = await session();
  await host.request(`/api/session/${current.id}/prompt`, { text: `DISCOVERY_SKILL ${name}` });
  await host.request(`/api/session/${current.id}/command`, { name: "discovery-wait", text: "" });
  const records = contextSchema.parse(
    await host.request(`/api/session/${current.id}/context`),
  ).data;
  const result = records
    .flatMap((record) => record.content ?? [])
    .find((part) => part.type === PartKind.Tool && part.name === "skill");
  assert.equal(result?.state?.status, ToolStateStatus.Completed, JSON.stringify({ name, records }));
  assert.ok(JSON.stringify(result.state.content).includes(name), JSON.stringify(result));
  assert.ok(JSON.stringify(result.state.content).includes(content), JSON.stringify(result));
}
console.log(
  JSON.stringify({
    runtime: host.runtime,
    missingRoots: "passed",
    commands: "passed",
    skills: "passed",
    skillLoading: "passed",
    precedence: "passed",
    unreadable: unprivileged ? "passed" : "skipped",
  }),
);
