import { PartKind, permissionEffects } from "../enums.js";
import { z } from "zod";

export const model = z.object({ providerID: z.string(), modelID: z.string() }).strict();
export const nativeModel = z
  .object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
  .strict();
export const permission = z
  .object({ permission: z.string(), pattern: z.string(), action: z.enum(permissionEffects) })
  .strict();
export const createBody = z
  .object({
    parentID: z.string().optional(),
    title: z.string().optional(),
    agent: z.string().optional(),
    model: nativeModel.optional(),
    permission: z.array(permission).optional(),
  })
  .strict();
export const updateBody = z
  .object({
    title: z.string().optional(),
    permission: z.array(permission).optional(),
    time: z.object({ archived: z.number().optional() }).strict().optional(),
  })
  .strict();
const mention = z.object({ start: z.number(), end: z.number(), value: z.string().optional() });
const part = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal(PartKind.Text),
      id: z.string().optional(),
      text: z.string(),
      synthetic: z.boolean().optional(),
      ignored: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal(PartKind.File),
      id: z.string().optional(),
      mime: z.string(),
      url: z.string(),
      filename: z.string().optional(),
      source: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal(PartKind.Agent),
      id: z.string().optional(),
      name: z.string(),
      source: mention.optional(),
    })
    .strict(),
]);
export const promptBody = z
  .object({
    messageID: z.string().optional(),
    model: model.optional(),
    agent: z.string().optional(),
    variant: z.string().optional(),
    noReply: z.boolean().optional(),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    parts: z.array(part),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    options: z.record(z.string(), z.json()).optional(),
    params: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export const summarizeBody = z
  .object({ providerID: z.string(), modelID: z.string(), auto: z.boolean().optional() })
  .strict();

export async function body<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  const text = await request.text();
  const value: unknown = text.length === 0 ? {} : JSON.parse(text);
  return schema.parse(value);
}
