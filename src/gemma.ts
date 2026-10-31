import {
  buildGemmaDiaryInput,
  sanitizeGemmaDiary,
  type DiaryDraft,
  type DiaryPlan,
} from "./diary";

export const GEMMA_MODEL_ID = "gemma4:latest";

const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const GEMMA_DIARY_SYSTEM_PROMPT = [
  "You write grounded reflections using only the facts and cues supplied in the user's message.",
  "Never invent or imply an object, place detail, action, event, or time reference. In particular, do not add a watch, route, destination, weather, prior day, or previous outing unless explicitly supplied.",
  "Do not speak as the user in first person. Address the user as 'you'. You may state a tentative interpretation as your own thought, but tie it to an explicit mood cue or behavior. Do not claim AI feelings, senses, actions, or presence.",
  "Do not diagnose or assign motives or personality traits. Do not use psychological labels the user did not provide. Be honest about tensions the evidence supports, but do not turn a single behavior into a character judgment.",
  "If an interesting detail is not supported by the supplied cues, leave it out. Accuracy matters more than embellishment.",
].join(" ");

const DIARY_CREATIVE_ANGLES = [
  "notice a small detail that quietly changes the day's meaning",
  "let the emotional impression emerge gradually rather than naming it first",
  "hold the day's plan beside what actually stood out",
  "give one ordinary detail a little room to resonate",
  "end with a gentle thought that remains open instead of summarizing",
  "notice a subtle contrast among the supplied moments",
];

type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
};

type OllamaChatOptions = {
  temperature?: number;
  top_p?: number;
  repeat_penalty?: number;
  frequency_penalty?: number;
  num_predict?: number;
};

let gemmaReady = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text();
  if (!body) return `Ollama returned HTTP ${response.status}.`;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error;
  } catch {
    return body.slice(0, 500);
  }
  return body.slice(0, 500);
}

async function checkOllama(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  } catch (error) {
    throw new Error(
      `Could not connect to Ollama at ${OLLAMA_BASE_URL}. Start Ollama and try again. ${
        error instanceof Error ? error.message : ""
      }`.trim(),
    );
  }
  if (!response.ok) throw new Error(`Ollama is unavailable. ${await responseError(response)}`);
}

export async function checkGemmaCompatibility(): Promise<{ supported: boolean; reason: string }> {
  try {
    await checkOllama();
    return { supported: true, reason: "" };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : "Ollama could not be checked.",
    };
  }
}

function pullProgress(event: unknown, onProgress: (progress: number, message: string) => void): void {
  if (!isRecord(event)) return;
  if (typeof event.error === "string") throw new Error(event.error);
  const status = typeof event.status === "string" ? event.status : "Preparing Gemma 4 with Ollama…";
  const total = typeof event.total === "number" ? event.total : 0;
  const completed = typeof event.completed === "number" ? event.completed : 0;
  const progress = total > 0 ? Math.max(0, Math.min(99, Math.round((completed / total) * 100))) : 0;
  const message = total > 0
    ? `${status} (${progress}%)`
    : `${status}…`;
  onProgress(progress, message);
}

async function pullGemma(onProgress: (progress: number, message: string) => void): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: GEMMA_MODEL_ID, stream: true }),
    });
  } catch (error) {
    throw new Error(
      `Ollama could not download ${GEMMA_MODEL_ID}. ${
        error instanceof Error ? error.message : "Check the Ollama connection and try again."
      }`,
    );
  }
  if (!response.ok) throw new Error(`Ollama could not download ${GEMMA_MODEL_ID}. ${await responseError(response)}`);
  if (!response.body) throw new Error("Ollama did not provide download progress.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event: unknown = JSON.parse(line);
      pullProgress(event, onProgress);
      if (isRecord(event) && event.status === "success") completed = true;
    }
    if (done) break;
  }
  if (pending.trim()) {
    const event: unknown = JSON.parse(pending);
    pullProgress(event, onProgress);
    if (isRecord(event) && event.status === "success") completed = true;
  }
  if (!completed) throw new Error(`Ollama did not confirm that ${GEMMA_MODEL_ID} finished downloading.`);
}

export async function loadGemma(
  onProgress: (progress: number, message: string) => void,
): Promise<void> {
  onProgress(0, "Checking for Gemma 4 in Ollama…");

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  } catch (error) {
    throw new Error(`Could not check Ollama models. ${error instanceof Error ? error.message : ""}`.trim());
  }
  if (!response.ok) throw new Error(`Could not check Ollama models. ${await responseError(response)}`);
  const payload: unknown = await response.json();
  const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  const installed = models.some((model) =>
    isRecord(model) && (model.name === GEMMA_MODEL_ID || model.model === GEMMA_MODEL_ID),
  );
  if (!installed) await pullGemma(onProgress);
  gemmaReady = true;
  onProgress(100, `Gemma 4 (${GEMMA_MODEL_ID}) is ready through Ollama.`);
}

function imageDataUrlToBase64(dataUrl: string): string {
  const separator = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/") || separator < 0 || !dataUrl.slice(separator + 1)) {
    throw new Error("The attached photo could not be prepared for local Gemma 4 analysis.");
  }
  return dataUrl.slice(separator + 1);
}

async function chat(
  messages: OllamaMessage[],
  options: OllamaChatOptions,
  imageDataUrl?: string,
): Promise<string> {
  if (!gemmaReady) throw new Error("Set up Gemma 4 through Ollama in Settings before using it.");
  if (imageDataUrl) {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      throw new Error("The photo could not be attached to a user message.");
    }
    lastMessage.images = [imageDataUrlToBase64(imageDataUrl)];
  }

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMMA_MODEL_ID,
        messages,
        stream: false,
        think: false,
        options,
      }),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the local Ollama service. ${error instanceof Error ? error.message : "Check that Ollama is running."}`,
    );
  }
  if (!response.ok) throw new Error(`Ollama could not generate a response. ${await responseError(response)}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isRecord(payload.message) || typeof payload.message.content !== "string") {
    throw new Error("Ollama returned an invalid chat response.");
  }
  return payload.message.content;
}

async function describePhotoLocally(photoDataUrl: string, onProgress: (message: string) => void): Promise<string> {
  onProgress("Analyzing the attached photo locally with Gemma 4…");
  const content = await chat(
    [{
      role: "user",
      content: "Describe only the clearly visible objects, setting, colors, and composition in this photo in one concise sentence. Do not infer identity, emotion, relationships, location, time, or events. If unclear, say so. This description will be used as optional detail in a personal diary.",
    }],
    { temperature: 0.2, num_predict: 80 },
    photoDataUrl,
  );
  if (!content.trim()) {
    throw new Error("Gemma 4 could not describe this image. You can try again without photo analysis.");
  }
  return content.trim().slice(0, 500);
}

export async function writeGemmaDiary(
  plan: DiaryPlan,
  draft: DiaryDraft,
  options: { analyzePhoto?: boolean; onProgress?: (message: string) => void } = {},
): Promise<string> {
  if (!gemmaReady) throw new Error("Load Gemma 4 through Ollama before writing with it.");
  let photoObservation = "";
  if (draft.photoDataUrl && options.analyzePhoto) {
    photoObservation = await describePhotoLocally(
      draft.photoDataUrl,
      options.onProgress ?? (() => undefined),
    );
  }
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
  const content = await chat(
    [
      { role: "system", content: GEMMA_DIARY_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    {
      temperature: 0.4,
      top_p: 0.82,
      repeat_penalty: 1.1,
      frequency_penalty: 0.12,
      num_predict: 200,
    },
  );
  if (content.trim().length < 60) {
    throw new Error("Gemma 4 returned an incomplete diary draft. Try generating it again or use the local draft.");
  }

  const cleaned = content
    .replace(/^\s*```(?:\w+)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const story = sanitizeGemmaDiary(cleaned, plan, draft);
  if (story.length < 60 || story.length > 5000) {
    throw new Error("Gemma 4’s draft did not pass the diary length check. Try again or use the local draft.");
  }
  return story;
}

export type OutingChatMessage = { role: "user" | "assistant"; content: string };

export async function rankNearbyPlacesWithGemma(
  mood: string,
  places: Array<{ id: string; name: string; category?: string; details: string }>,
): Promise<Array<{ id: string; reason: string }>> {
  if (!gemmaReady) throw new Error("Set up Gemma 4 in Settings to match nearby places to your mood.");
  const candidates = places.slice(0, 30).map(({ id, name, category, details }) => ({
    id, name, category: category ?? "mapped place", mappedDetails: details.slice(0, 240),
  }));
  const content = await chat(
    [
      { role: "system", content: "You match nearby places to the user's stated mood. Use only these candidate places and their supplied map categories. Do not invent amenities, hours, access, safety, atmosphere, or distance comparisons. Return JSON only: an array of up to 8 objects with id and a brief, tentative reason grounded in the mood and supplied category. Never repeat private diary details in the reason; keep it discreet." },
      { role: "user", content: JSON.stringify({ mood: mood.slice(0, 1000), candidates }) },
    ],
    { temperature: 0.55, num_predict: 320 },
  );
  if (!content) throw new Error("Gemma 4 did not return place matches.");
  const cleaned = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Gemma 4 returned an invalid place ranking.");
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
  if (!gemmaReady) throw new Error("Set up Gemma 4 in Settings before starting a conversation with the local AI companion.");
  const recentMessages: OllamaMessage[] = messages.slice(-8).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 1200),
  }));
  const content = await chat(
    [
      {
        role: "system",
        content: "You are Daymark, a thoughtful, friendly conversation buddy accompanying someone on an outing. Respond naturally to what they just said, with warmth and interest, and ask at most one gentle follow-up question when it fits. Be candid, emotionally perceptive, and never pretend to see, hear, or know details the user did not share. Do not diagnose, overpraise, or turn every response into advice. Vary your phrasing. Keep spoken-friendly replies to one or two concise sentences. The place and locality are context only; never invent sensory details about them.",
      },
      { role: "user", content: `Outing context (not a claim about what the user experienced): ${context.place}, ${context.locality}.` },
      ...recentMessages,
    ],
    {
      temperature: 0.75,
      top_p: 0.9,
      repeat_penalty: 1.12,
      num_predict: 110,
    },
  );
  if (!content.trim()) throw new Error("Gemma 4 did not return a reply. Please try again.");
  return content.trim().replace(/^\s*["'“”]+|["'“”]+\s*$/g, "").slice(0, 900);
}

export async function unloadGemma(): Promise<void> {
  if (!gemmaReady) return;
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: GEMMA_MODEL_ID, prompt: "", keep_alive: 0, stream: false }),
    });
  } catch (error) {
    throw new Error(`Could not unload Gemma 4 from Ollama memory. ${error instanceof Error ? error.message : ""}`.trim());
  }
  if (!response.ok) throw new Error(`Could not unload Gemma 4 from Ollama memory. ${await responseError(response)}`);
  gemmaReady = false;
}
