import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { Model, Plugin, Provider } from "@opencode/plugin";

export type Script = (
  request: LanguageModelV3CallOptions,
) => Promise<LanguageModelV3GenerateResult>;

export const testModel = { providerID: "omsg-test", id: "scripted" } as const;

export function answer(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

export function scriptedProvider(script: Script): Plugin.Plugin {
  const providerID = Provider.ID.make(testModel.providerID);
  const modelID = Model.ID.make(testModel.id);
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: testModel.providerID,
    modelId: testModel.id,
    supportedUrls: {},
    doGenerate: script,
    async doStream(request) {
      const result = await script(request);
      const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: result.warnings },
      ];
      for (const [index, content] of result.content.entries()) {
        switch (content.type) {
          case "text": {
            const id = String(index);
            parts.push(
              { type: "text-start", id },
              { type: "text-delta", id, delta: content.text },
              { type: "text-end", id },
            );
            break;
          }
          case "tool-call":
            parts.push(content);
            break;
          default:
            throw new UnsupportedScriptContent(content.type);
        }
      }
      parts.push({
        type: "finish",
        usage: result.usage,
        finishReason: result.finishReason,
      });
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return Plugin.define({
    id: "omsg-test-provider",
    async setup(context) {
      await context.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            activation: "enabled",
            package: "aisdk:omsg-test",
          },
          models: [
            { ...Model.Info.default(providerID, modelID), package: "aisdk:omsg-test" },
          ],
        });
      });
      await context.aisdk.hook(
        "sdk",
        (event) => {
          event.sdk = { languageModel: () => model };
        },
        { providerID },
      );
      await context.aisdk.hook(
        "language",
        (event) => {
          event.language = model;
        },
        { providerID },
      );
      await context.session.hook("title", (event) => {
        event.result = "omsg test";
      });
    },
  });
}

class UnsupportedScriptContent extends Error {
  constructor(readonly contentType: string) {
    super(`The scripted test provider cannot stream ${contentType}.`);
    this.name = "UnsupportedScriptContent";
  }
}
