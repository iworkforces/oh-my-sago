import { PartKind, type PermissionEffect, permissionEffects } from "../enums.js";
import { z } from "zod";
import { json } from "../domains/value.js";

type OptionalString = z.ZodOptional<z.ZodString>;
type OptionalNumber = z.ZodOptional<z.ZodNumber>;
type OptionalBoolean = z.ZodOptional<z.ZodBoolean>;
type ModelSchema = z.ZodObject<{ providerID: z.ZodString; modelID: z.ZodString }, z.core.$strict>;
type NativeModelSchema = z.ZodObject<
  { providerID: z.ZodString; id: z.ZodString; variant: OptionalString },
  z.core.$strict
>;
type PermissionSchema = z.ZodObject<
  {
    permission: z.ZodString;
    pattern: z.ZodString;
    action: z.ZodEnum<{ [Effect in PermissionEffect]: Effect }>;
  },
  z.core.$strict
>;
type MentionSchema = z.ZodObject<{
  start: z.ZodNumber;
  end: z.ZodNumber;
  value: OptionalString;
}>;
type PartSchema = z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        type: z.ZodLiteral<typeof PartKind.Text>;
        id: OptionalString;
        text: z.ZodString;
        synthetic: OptionalBoolean;
        ignored: OptionalBoolean;
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<typeof PartKind.File>;
        id: OptionalString;
        mime: z.ZodString;
        url: z.ZodString;
        filename: OptionalString;
        source: z.ZodOptional<z.ZodJSONSchema>;
      },
      z.core.$strict
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<typeof PartKind.Agent>;
        id: OptionalString;
        name: z.ZodString;
        source: z.ZodOptional<MentionSchema>;
      },
      z.core.$strict
    >,
  ],
  "type"
>;

const model: ModelSchema = z.object({ providerID: z.string(), modelID: z.string() }).strict();
const nativeModel: NativeModelSchema = z
  .object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
  .strict();
export const permission: PermissionSchema = z
  .object({ permission: z.string(), pattern: z.string(), action: z.enum(permissionEffects) })
  .strict();
export const createBody: z.ZodObject<
  {
    parentID: OptionalString;
    title: OptionalString;
    agent: OptionalString;
    model: z.ZodOptional<NativeModelSchema>;
    permission: z.ZodOptional<z.ZodArray<PermissionSchema>>;
  },
  z.core.$strict
> = z
  .object({
    parentID: z.string().optional(),
    title: z.string().optional(),
    agent: z.string().optional(),
    model: nativeModel.optional(),
    permission: z.array(permission).optional(),
  })
  .strict();
export const updateBody: z.ZodObject<
  {
    title: OptionalString;
    permission: z.ZodOptional<z.ZodArray<PermissionSchema>>;
    time: z.ZodOptional<z.ZodObject<{ archived: OptionalNumber }, z.core.$strict>>;
  },
  z.core.$strict
> = z
  .object({
    title: z.string().optional(),
    permission: z.array(permission).optional(),
    time: z.object({ archived: z.number().optional() }).strict().optional(),
  })
  .strict();
const mention: MentionSchema = z.object({
  start: z.number(),
  end: z.number(),
  value: z.string().optional(),
});
const part: PartSchema = z.discriminatedUnion("type", [
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
      source: json.optional(),
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
export const promptBody: z.ZodObject<
  {
    messageID: OptionalString;
    model: z.ZodOptional<ModelSchema>;
    agent: OptionalString;
    variant: OptionalString;
    noReply: OptionalBoolean;
    system: OptionalString;
    tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    parts: z.ZodArray<PartSchema>;
    temperature: OptionalNumber;
    topP: OptionalNumber;
    topK: OptionalNumber;
    maxOutputTokens: OptionalNumber;
    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
    params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
  },
  z.core.$strict
> = z
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
export const summarizeBody: z.ZodObject<
  { providerID: z.ZodString; modelID: z.ZodString; auto: OptionalBoolean },
  z.core.$strict
> = z
  .object({ providerID: z.string(), modelID: z.string(), auto: z.boolean().optional() })
  .strict();

export async function body<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  const text = await request.text();
  return schema.parse(text.length === 0 ? {} : JSON.parse(text));
}
