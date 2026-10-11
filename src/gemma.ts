import { ModelType, type MLCEngineInterface } from "@mlc-ai/web-llm";
import {
  buildGemmaDiaryInput,
  sanitizeGemmaDiary,
  type DiaryDraft,
  type DiaryPlan,
} from "./diary";

export const GEMMA_MODEL_ID = "gemma-2-2b-it-q4f16_1-MLC";
export const GEMMA_MODEL_SIZE = "1.49 GB";
export const GEMMA_REQUIRED_GPU_MEMORY_MB = 1896;
export const PHOTO_VISION_MODEL_ID = "Phi-3.5-vision-instruct-q4f16_1-MLC";
export const PHOTO_VISION_MODEL_SIZE = "2.77 GB";
export const PHOTO_VISION_REQUIRED_GPU_MEMORY_MB = 3953;

const GEMMA_DIARY_SYSTEM_PROMPT = [
  "You write grounded reflections using only the facts and cues supplied in the user's message.",
  "Never invent or imply an object, place detail, action, event, or time reference. In particular, do not add a watch, route, destination, weather, prior day, or previous outing unless explicitly supplied.",
  "Do not speak as the user in first person. Address the user as 'you'. You may state a tentative interpretation as your own thought, but tie it to an explicit mood cue or behavior. Do not claim AI feelings, senses, actions, or presence.",
  "Do not diagnose or assign motives or personality traits. Do not use psychological labels the user did not provide. Be honest about tensions the evidence supports, but do not turn a single behavior into a character judgment.",
  "If an interesting detail is not supported by the supplied cues, leave it out. Accuracy matters more than embellishment.",
].join(" ");

const GEMMA_WASM_CDN_PREFIX =
  "https://cdn.jsdelivr.net/gh/mlc-ai/binary-mlc-llm-libs@025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models";
const DEFAULT_WASM_PREFIX =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models";
const DIARY_CREATIVE_ANGLES = [
  "notice a small detail that quietly changes the day's meaning",
  "let the emotional impression emerge gradually rather than naming it first",
  "hold the day's plan beside what actually stood out",
  "give one ordinary detail a little room to resonate",
  "end with a gentle thought that remains open instead of summarizing",
  "notice a subtle contrast among the supplied moments",
];

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

async function loadPhotoVision(
  onProgress: (message: string) => void,
): Promise<MLCEngineInterface> {
  const { CreateMLCEngine, prebuiltAppConfig } = await import("@mlc-ai/web-llm");
  const model = prebuiltAppConfig.model_list.find((item) => item.model_id === PHOTO_VISION_MODEL_ID);
  if (!model || model.model_type !== ModelType.VLM) {
    throw new Error("The installed WebLLM package does not include the expected local vision model.");
  }
  const appConfig = {
    ...prebuiltAppConfig,
    model_list: prebuiltAppConfig.model_list.map((item) =>
      item.model_id === PHOTO_VISION_MODEL_ID && item.model_lib.startsWith(DEFAULT_WASM_PREFIX)
        ? { ...item, model_lib: item.model_lib.replace(DEFAULT_WASM_PREFIX, GEMMA_WASM_CDN_PREFIX) }
        : item,
    ),
  };
  onProgress("Loading the local photo model…");
  return CreateMLCEngine(PHOTO_VISION_MODEL_ID, {
    appConfig,
    logLevel: "WARN",
    initProgressCallback: ({ progress, text }) => {
      onProgress(text || `Preparing the photo model on this device (${Math.round(progress * 100)}%)…`);
    },
  });
}

async function describePhotoLocally(photoDataUrl: string, onProgress: (message: string) => void): Promise<string> {
  onProgress("Analyzing the attached photo locally…");
  const vision = await loadPhotoVision(onProgress);
  engine = vision;
  const result = await vision.chat.completions.create({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Describe only the clearly visible objects, setting, colors, and composition in this photo in one concise sentence. Do not infer identity, emotion, relationships, location, time, or events. If unclear, say so. This description will be used as optional detail in a personal diary." },
        { type: "image_url", image_url: { url: photoDataUrl } },
      ],
    }],
    temperature: 0.2,
    max_tokens: 80,
  });
  const content = result.choices[0]?.message.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The local photo model could not describe this image. You can try again without photo analysis.");
  }
  return content.trim().slice(0, 500);
}

export async function writeGemmaDiary(
  plan: DiaryPlan,
  draft: DiaryDraft,
  options: { analyzePhoto?: boolean; onProgress?: (message: string) => void } = {},
): Promise<string> {
  if (!engine) throw new Error("Load Gemma on this device before writing with it.");
  let photoObservation = "";
  if (draft.photoDataUrl && options.analyzePhoto) {
    options.onProgress?.("Switching from Gemma to the local photo model…");
    await unloadGemma();
    try {
      photoObservation = await describePhotoLocally(draft.photoDataUrl, options.onProgress ?? (() => undefined));
    } finally {
      if (engine) {
        await engine.unload();
        engine = null;
        enginePromise = null;
      }
      options.onProgress?.("Reloading Gemma to write your diary…");
      await loadGemma((_, message) => options.onProgress?.(message || "Reloading Gemma to write your diary…"));
    }
  }
  if (!engine) throw new Error("Gemma could not be restored after photo analysis.");
  const creativeAngle = DIARY_CREATIVE_ANGLES[Math.floor(Math.random() * DIARY_CREATIVE_ANGLES.length)];
  const conversationLog = (draft.conversation ?? [])
    .filter(({ content }) => content.trim())
    .map(({ role, content }) => `${role === "user" ? "USER" : "GEMMA"}: ${content.trim()}`)
    .join("\n\n");
  const conversationFile = new File(
    [conversationLog || "No conversation was recorded during this outing."],
    "outing-conversation.txt",
    { type: "text/plain;charset=utf-8" },
  );
  const conversationTranscript = await conversationFile.text();
  const { prompt } = buildGemmaDiaryInput(plan, draft, photoObservation, creativeAngle, conversationTranscript);
  const result = await engine.chat.completions.create({
    messages: [
      { role: "system", content: GEMMA_DIARY_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
    top_p: 0.82,
    repetition_penalty: 1.1,
    frequency_penalty: 0.12,
    max_tokens: 200,
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

export type OutingChatMessage = { role: "user" | "assistant"; content: string };

export async function rankNearbyPlacesWithGemma(
  mood: string,
  places: Array<{ id: string; name: string; category?: string; details: string }>,
): Promise<Array<{ id: string; reason: string }>> {
  if (!engine) throw new Error("Set up Gemma in Settings to match nearby places to your mood.");
  const candidates = places.slice(0, 30).map(({ id, name, category, details }) => ({
    id, name, category: category ?? "mapped place", mappedDetails: details.slice(0, 240),
  }));
  const result = await engine.chat.completions.create({
    messages: [
      { role: "system", content: "You match nearby places to the user's stated mood. Use only these candidate places and their supplied map categories. Do not invent amenities, hours, access, safety, atmosphere, or distance comparisons. Return JSON only: an array of up to 8 objects with id and a brief, tentative reason grounded in the mood and supplied category. Never repeat private diary details in the reason; keep it discreet." },
      { role: "user", content: JSON.stringify({ mood: mood.slice(0, 1000), candidates }) },
    ],
    temperature: 0.55,
    max_tokens: 320,
  });
  const content = result.choices[0]?.message.content;
  if (typeof content !== "string") throw new Error("Gemma did not return place matches.");
  const cleaned = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Gemma returned an invalid place ranking.");
  const validIds = new Set(candidates.map((place) => place.id));
  const seen = new Set<string>();
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { id, reason } = item as { id?: unknown; reason?: unknown };
    if (typeof id !== "string" || !validIds.has(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, reason: typeof reason === "string" ? reason.slice(0, 220) : "A possible match for what you described." }];
  }).slice(0, 8);
}

export async function replyWithGemma(
  messages: OutingChatMessage[],
  context: { place: string; locality: string },
): Promise<string> {
  if (!engine) throw new Error("Set up Gemma in Settings before starting a conversation with the local AI companion.");
  const recentMessages = messages.slice(-8).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 1200),
  }));
  const result = await engine.chat.completions.create({
    messages: [
      {
        role: "system",
        content: "You are Daymark, a thoughtful, friendly conversation buddy accompanying someone on an outing. Respond naturally to what they just said, with warmth and interest, and ask at most one gentle follow-up question when it fits. Be candid, emotionally perceptive, and never pretend to see, hear, or know details the user did not share. Do not diagnose, overpraise, or turn every response into advice. Vary your phrasing. Keep spoken-friendly replies to one or two concise sentences. The place and locality are context only; never invent sensory details about them.",
      },
      { role: "user", content: `Outing context (not a claim about what the user experienced): ${context.place}, ${context.locality}.` },
      ...recentMessages,
    ],
    temperature: 0.75,
    top_p: 0.9,
    repetition_penalty: 1.12,
    max_tokens: 110,
  });
  const content = result.choices[0]?.message.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Gemma did not return a reply. Please try again.");
  return content.trim().replace(/^\s*["'“”]+|["'“”]+\s*$/g, "").slice(0, 900);
}

export async function forgetGemma(): Promise<void> {
  if (engine) {
    await engine.unload();
    engine = null;
    enginePromise = null;
  }
  const { deleteModelAllInfoInCache } = await import("@mlc-ai/web-llm");
  await Promise.all([
    deleteModelAllInfoInCache(GEMMA_MODEL_ID),
    deleteModelAllInfoInCache(PHOTO_VISION_MODEL_ID),
  ]);
}

export async function unloadGemma(): Promise<void> {
  if (!engine) return;
  await engine.unload();
  engine = null;
  enginePromise = null;
}
