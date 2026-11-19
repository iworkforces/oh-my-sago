import type { Info } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import { ErrorName } from "../enums.js";
import { z } from "zod";

export class CompatibilityError extends Error {
  readonly feature: string;
  constructor(feature: string) {
    super(`Legacy configuration is not supported by OpenCode 2.3.0: ${feature}`);
    this.name = ErrorName.Compatibility;
    this.feature = feature;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const json = z.json();
export type Json = z.infer<typeof json>;
export const jsonRecord = z.record(z.string(), json);
export type JsonRecord = z.infer<typeof jsonRecord>;

export function metadata(value: object | undefined): JsonRecord {
  return jsonRecord.parse(JSON.parse(JSON.stringify(value ?? {})));
}

export function inputSchema(value: Info["input"]): JsonRecord {
  if (value instanceof z.ZodType) return jsonRecord.parse(z.toJSONSchema(value));
  if (Schema.isSchema(value)) {
    const document = Schema.toJsonSchemaDocument(value);
    return jsonRecord.parse({ ...document.schema, $defs: document.definitions });
  }
  return jsonRecord.parse(value);
}

const nativeNames: Readonly<Record<string, string>> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  run_shell: "bash",
};

const legacyNames: ReadonlyMap<string, string> = new Map(
  Object.entries(nativeNames).map(([native, legacy]) => [legacy, native]),
);

export function legacyName(name: string): string {
  return nativeNames[name] ?? name;
}

export function nativeName(name: string): string {
  return legacyNames.get(name) ?? name;
}

export function legacyArguments(name: string, input: unknown): unknown {
  const alias = legacyName(name);
  if (!["read", "write", "edit"].includes(alias)) return input;
  const args = z.record(z.string(), z.unknown()).parse(input);
  const { path, ...rest } = args;
  return { ...rest, ...(path === undefined ? {} : { filePath: path }) };
}

export function nativeArguments(name: string, input: unknown): unknown {
  const alias = legacyName(name);
  if (!["read", "write", "edit"].includes(alias)) return input;
  const args = z.record(z.string(), z.unknown()).parse(input);
  const { filePath, ...rest } = args;
  return { ...rest, ...(filePath === undefined ? {} : { path: filePath }) };
}
