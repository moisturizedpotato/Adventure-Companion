const MAX_BODY_BYTES = 30 * 1024;
const MAX_TEXT_LENGTH = 5000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_CALLS_PER_WINDOW = 30;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

export function createElevenLabsHandler({ env = process.env, fetchImpl = fetch } = {}) {
  const requestsByAddress = new Map();
  return async function handleElevenLabsRequest(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname !== "/api/voice/status" && pathname !== "/api/voice/speak") return false;

    if (pathname === "/api/voice/status") {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return true;
      }
      sendJson(response, 200, { configured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) });
      return true;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end();
      return true;
    }
    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
      sendJson(response, 503, { error: { code: "voice_not_configured", message: "Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID on the application server to enable ElevenLabs speech." } });
      return true;
    }

    const now = Date.now();
    const address = request.socket?.remoteAddress ?? "unknown";
    const recentRequests = (requestsByAddress.get(address) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
    if (recentRequests.length >= MAX_CALLS_PER_WINDOW) {
      sendJson(response, 429, { error: { code: "speech_rate_limited", message: "This server has reached its speech generation limit for this hour. Please try again later." } });
      return true;
    }
    recentRequests.push(now);
    requestsByAddress.set(address, recentRequests);

    try {
      const body = await readBody(request);
      if (!body || typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_TEXT_LENGTH) {
        sendJson(response, 400, { error: { code: "invalid_text", message: `Text must be between 1 and ${MAX_TEXT_LENGTH} characters.` } });
        return true;
      }

      const upstream = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: body.text.trim(),
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.42, similarity_boost: 0.75, style: 0.35, speed: 0.94, use_speaker_boost: true },
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!upstream.ok) {
        const messages = {
          401: "ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY.",
          403: "ElevenLabs denied this request. Check your account access and selected voice.",
          404: "ElevenLabs could not find this voice. Check ELEVENLABS_VOICE_ID.",
          429: "ElevenLabs is rate limiting speech generation. Please wait and try again.",
        };
        const providerError = await upstream.json().catch(() => null);
        const providerMessage = providerError?.detail?.message;
        sendJson(response, upstream.status >= 500 ? 502 : upstream.status, { error: { code: "speech_provider_error", message: messages[upstream.status] ?? providerMessage ?? "ElevenLabs could not make speech for this text." } });
        return true;
      }
      const audio = Buffer.from(await upstream.arrayBuffer());
      if (!audio.length || audio.length > MAX_AUDIO_BYTES) {
        sendJson(response, 502, { error: { code: "invalid_speech_response", message: "ElevenLabs returned an empty or oversized audio response." } });
        return true;
      }
      response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(audio);
      return true;
    } catch (error) {
      sendJson(response, error.status ?? 502, { error: { code: "speech_request_failed", message: error.status ? error.message : "Speech generation failed. Check the server connection and try again." } });
      return true;
    }
  };
}
