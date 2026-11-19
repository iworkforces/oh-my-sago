import type { Stats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Config } from "@opencode-ai/sdk";
import { Skill, type Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { z } from "zod";
import { errorMessage } from "./domains/value.js";

const frontmatter = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  subtask: z.boolean().optional(),
  autoinvoke: z.boolean().optional(),
});

function skipUnreadable(path: string, error: unknown): void {
  console.warn("omsago: Skipping unreadable path", {
    path,
    reason: errorMessage(error),
  });
}

async function* markdownFiles(root: string) {
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) break;
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
      )
        continue;
      skipUnreadable(path, error);
      continue;
    }
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    let entry: Stats;
    try {
      entry = await stat(canonical);
    } catch (error) {
      skipUnreadable(path, error);
      continue;
    }
    if (entry.isDirectory()) {
      let names: string[];
      try {
        names = (await readdir(path)).sort().reverse();
      } catch (error) {
        skipUnreadable(path, error);
        continue;
      }
      for (const name of names) {
        if (!name.startsWith(".") && name !== "node_modules") pending.push(join(path, name));
      }
    } else if (entry.isFile() && path.endsWith(".md")) {
      yield { path, canonical };
    }
  }
}

async function markdown(file: { readonly path: string; readonly canonical: string }) {
  let text: string;
  try {
    text = await readFile(file.canonical, "utf8");
  } catch (error) {
    skipUnreadable(file.path, error);
    return undefined;
  }
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  try {
    const yaml = header?.[1];
    return {
      metadata: frontmatter.parse(yaml === undefined ? {} : (Bun.YAML.parse(yaml) ?? {})),
      content: text.slice(header?.[0].length ?? 0).trim(),
    };
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
    console.warn("omsago: Skipping Markdown with invalid frontmatter", { path: file.path });
    return undefined;
  }
}

type CommandDefinition = NonNullable<Config["command"]>[string];

export interface UserDiscovery {
  readonly commands: Record<string, CommandDefinition>;
  readonly dispose: Registration["dispose"];
}

export async function registerUserDiscovery(context: Plugin.Context): Promise<UserDiscovery> {
  const commands = new Map<string, CommandDefinition>();
  const skills = new Map<string, Skill.Info>();
  for (const directory of [".agents", ".opencode"]) {
    const root = join(homedir(), directory);
    const commandRoot = join(root, "commands");
    for await (const file of markdownFiles(commandRoot)) {
      const entry = await markdown(file);
      if (entry === undefined) continue;
      const { metadata, content } = entry;
      commands.set(relative(commandRoot, file.path).slice(0, -3).split(sep).join("/"), {
        template: content,
        ...(metadata.description === undefined ? {} : { description: metadata.description }),
        ...(metadata.agent === undefined ? {} : { agent: metadata.agent }),
        ...(metadata.model === undefined ? {} : { model: metadata.model }),
        ...(metadata.subtask === undefined ? {} : { subtask: metadata.subtask }),
      });
    }
    const skillRoot = join(root, "skills");
    for await (const file of markdownFiles(skillRoot)) {
      if (basename(file.path) !== "SKILL.md") continue;
      const entry = await markdown(file);
      if (entry === undefined) continue;
      const { metadata, content } = entry;
      const name = metadata.name ?? basename(dirname(file.path));
      const id = relative(skillRoot, dirname(file.path)).split(sep).join("/");
      skills.set(
        id,
        Skill.Info.make({
          id: Skill.ID.make(id),
          name: Skill.Name.make(name),
          path: Skill.Info.fields.path.make(file.canonical),
          content,
          ...(metadata.description === undefined ? {} : { description: metadata.description }),
          ...(metadata.autoinvoke === undefined ? {} : { autoinvoke: metadata.autoinvoke }),
        }),
      );
    }
  }
  const existing = new Set((await context.command.list()).data.map((command) => command.name));
  const registration = await context.skill.transform((editor) => {
    for (const skill of skills.values()) {
      if (
        editor.get(skill.id) !== undefined ||
        editor.list().some((entry) => entry.name === skill.name)
      )
        continue;
      editor.add(skill);
    }
  });
  return {
    commands: Object.fromEntries([...commands].filter(([name]) => !existing.has(name))),
    dispose: registration.dispose,
  };
}
