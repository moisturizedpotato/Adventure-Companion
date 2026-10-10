import type { MLCEngineInterface } from "@mlc-ai/web-llm";
import {
  buildGemmaDiaryInput,
  sanitizeGemmaDiary,
  type DiaryDraft,
  type DiaryPlan,
} from "./diary";

export const GEMMA_MODEL_ID = "gemma-2-2b-it-q4f16_1-MLC";
export const GEMMA_MODEL_SIZE = "1.49 GB";
export const GEMMA_REQUIRED_GPU_MEMORY_MB = 1896;

const GEMMA_WASM_CDN_PREFIX =
  "https://cdn.jsdelivr.net/gh/mlc-ai/binary-mlc-llm-libs@025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models";
const DEFAULT_WASM_PREFIX =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models";

let engine: MLCEngineInterface | null = null;
let enginePromise: Promise<MLCEngineInterface> | null = null;

export async function checkGemmaCompatibility(): Promise<{ supported: boolean; reason: string }> {
  if (!window.isSecureContext) {
    return { supported: false, reason: "Gemma requires a secure context, such as localhost or HTTPS." };
  }

  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<{ features: { has: (feature: string) => boolean } } | null> };
  }).gpu;
  if (!gpu) return { supported: false, reason: "This browser does not expose WebGPU." };

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { supported: false, reason: "No compatible WebGPU adapter was found." };
    if (!adapter.features.has("shader-f16")) {
      return { supported: false, reason: "This GPU does not support the shader-f16 feature required by this Gemma build." };
    }
    return { supported: true, reason: "" };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? `WebGPU check failed: ${error.message}` : "WebGPU could not be checked.",
    };
  }
}

export async function loadGemma(
  onProgress: (progress: number, message: string) => void,
): Promise<void> {
  if (engine) return;
  if (!enginePromise) {
    enginePromise = (async () => {
      onProgress(0, "Loading the local inference runtime…");
      const { CreateMLCEngine, prebuiltAppConfig } = await import("@mlc-ai/web-llm");
      const modelRecord = prebuiltAppConfig.model_list.find((model) => model.model_id === GEMMA_MODEL_ID);
      if (!modelRecord || !modelRecord.model_lib.startsWith(DEFAULT_WASM_PREFIX)) {
        throw new Error("The installed WebLLM package does not contain the expected Gemma runtime configuration.");
      }
      const appConfig = {
        ...prebuiltAppConfig,
        model_list: prebuiltAppConfig.model_list.map((model) =>
          model.model_id === GEMMA_MODEL_ID
            ? { ...model, model_lib: model.model_lib.replace(DEFAULT_WASM_PREFIX, GEMMA_WASM_CDN_PREFIX) }
            : model,
        ),
      };
      onProgress(0, "Fetching the Gemma runtime and checking local model files…");
      return CreateMLCEngine(GEMMA_MODEL_ID, {
        appConfig,
        logLevel: "WARN",
        initProgressCallback: ({ progress, text }) => {
          onProgress(
            Math.max(0, Math.min(100, Math.round(progress * 100))),
            text || "Preparing Gemma on this device…",
          );
        },
      });
    })();
  }

  try {
    engine = await enginePromise;
  } catch (error) {
    enginePromise = null;
    throw error;
  }
}

export async function writeGemmaDiary(plan: DiaryPlan, draft: DiaryDraft): Promise<string> {
  if (!engine) throw new Error("Load Gemma on this device before writing with it.");
  const { prompt } = buildGemmaDiaryInput(plan, draft);
  const result = await engine.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.88,
    top_p: 0.92,
    repetition_penalty: 1.13,
    frequency_penalty: 0.12,
    max_tokens: 460,
  });
  const content = result.choices[0]?.message.content;
  if (typeof content !== "string" || content.trim().length < 60) {
    throw new Error("Gemma returned an incomplete diary draft. Try generating it again or use the local draft.");
  }

  const cleaned = content
    .replace(/^\s*```(?:\w+)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const story = sanitizeGemmaDiary(cleaned, plan, draft);
  if (story.length < 60 || story.length > 5000) {
    throw new Error("Gemma’s draft did not pass the diary length check. Try again or use the local draft.");
  }
  return story;
}

export async function forgetGemma(): Promise<void> {
  if (engine) {
    await engine.unload();
    engine = null;
    enginePromise = null;
  }
  const { deleteModelAllInfoInCache } = await import("@mlc-ai/web-llm");
  await deleteModelAllInfoInCache(GEMMA_MODEL_ID);
}

export async function unloadGemma(): Promise<void> {
  if (!engine) return;
  await engine.unload();
  engine = null;
  enginePromise = null;
}
