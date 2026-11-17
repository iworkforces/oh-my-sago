import type { CommandInvocation } from "@opencode/plugin/promise/command";
import type { Plugin } from "@opencode/plugin";

type NativePrompt = Pick<
  Parameters<Plugin.Context["session"]["prompt"]>[0],
  "text" | "files" | "agents" | "skills"
>;

export function promptInput(prompt: CommandInvocation["prompt"]): NativePrompt {
  return {
    text: prompt.text,
    ...(prompt.files === undefined
      ? {}
      : {
          files: prompt.files.map((file) => ({
            uri: file.uri,
            ...(file.source === undefined ? {} : { source: file.source }),
            ...(file.name === undefined ? {} : { name: file.name }),
            ...(file.description === undefined ? {} : { description: file.description }),
            ...(file.mention === undefined ? {} : { mention: file.mention }),
          })),
        }),
    ...(prompt.agents === undefined
      ? {}
      : {
          agents: prompt.agents.map((agent) => ({
            name: agent.name,
            ...(agent.mention === undefined ? {} : { mention: agent.mention }),
          })),
        }),
    ...(prompt.skills === undefined
      ? {}
      : {
          skills: prompt.skills.map((skill) => ({
            id: skill.id,
            ...(skill.mention === undefined ? {} : { mention: skill.mention }),
          })),
        }),
  };
}
