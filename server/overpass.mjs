import { setTimeout as delay } from "node:timers/promises";
import { requestGeoapifyPlaces } from "./geoapify.mjs";

export const NEARBY_RADIUS_METERS = 3000;
export const OVERPASS_ENDPOINTS = Object.freeze([
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
]);
export const DEFAULT_OVERPASS_USER_AGENT =
  "Wayfarer/1.0 (+https://github.com/moisturizedpotato/Adventure-Companion)";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 5000;
const MAX_TEXT_LENGTH = 300;
const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const MAX_RETRY_DELAY_MS = 1500;
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [250, 500];

export class NearbyApiError extends Error {
  constructor(status, code, message, retryable = false, upstreamAttempts) {
    super(message);
    this.name = "NearbyApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.upstreamAttempts = upstreamAttempts;
  }
}

export function buildNearbyQuery({ latitude, longitude, radius, interests, refinement = "" }) {
  const location = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const categoryFilters = {
    green: `nwr(around:${radius},${location})["name"]["leisure"~"^(park|garden|nature_reserve)$"];`,
    quiet: `nwr(around:${radius},${location})["name"]["amenity"~"^(library|cafe)$"];nwr(around:${radius},${location})["name"]["shop"="books"];`,
    culture: `nwr(around:${radius},${location})["name"]["tourism"~"^(museum|gallery|attraction|artwork)$"];nwr(around:${radius},${location})["name"]["amenity"~"^(museum|arts_centre|theatre|cinema)$"];`,
    food: `nwr(around:${radius},${location})["name"]["amenity"~"^(cafe|restaurant|fast_food|food_court)$"];`,
    active: `nwr(around:${radius},${location})["name"]["sport"];nwr(around:${radius},${location})["name"]["leisure"~"^(sports_centre|pitch|skatepark|swimming_pool|climbing)$"];nwr(around:${radius},${location})["name"]["tourism"="viewpoint"];`,
  };
  const requestedCategories = interests.split(",").map((item) => item.trim()).filter((item) => item in categoryFilters);
  if (!refinement && requestedCategories.length) {
    const filters = [...new Set(requestedCategories)].slice(0, 3).map((category) => categoryFilters[category]).join("");
    return `[out:json][timeout:18];(${filters});out center tags 120;`;
  }
  const adventureInterest = /adventure|thrill|active|explor|outdoor|activity|sport|hike|climb/i.test(interests);
  const studyInterest = /stud|learn|read|book|quiet|work/i.test(interests);
  const refinedActivity = /kayak|canoe|paddl|whitewater/i.test(refinement)
    ? `nwr(around:${radius},${location})["name"]["amenity"="boat_rental"];nwr(around:${radius},${location})["name"]["sport"~"^(canoe|kayak|paddling|whitewater)$"];`
    : /rowing/i.test(refinement)
      ? `nwr(around:${radius},${location})["name"]["amenity"="boat_rental"];nwr(around:${radius},${location})["name"]["sport"="rowing"];`
      : /climb|bould|zip.?line/i.test(refinement)
        ? `nwr(around:${radius},${location})["name"]["amenity"="climbing"];nwr(around:${radius},${location})["name"]["leisure"~"^(climbing|adventure_park)$"];`
        : /cycl|bik|mountain.?bike/i.test(refinement)
          ? `nwr(around:${radius},${location})["name"]["sport"~"^(cycling|mountain_biking|bmx)$"];nwr(around:${radius},${location})["name"]["amenity"="bicycle_rental"];`
          : /hike|walk|trail/i.test(refinement)
            ? `nwr(around:${radius},${location})["name"]["route"~"^(hiking|foot)$"];nwr(around:${radius},${location})["name"]["leisure"~"^(nature_reserve|park)$"];`
            : /skat/i.test(refinement)
              ? `nwr(around:${radius},${location})["name"]["leisure"="skatepark"];nwr(around:${radius},${location})["name"]["sport"~"^(skateboarding|roller_skating)$"];`
              : /swim|pool/i.test(refinement)
                ? `nwr(around:${radius},${location})["name"]["leisure"="swimming_pool"];nwr(around:${radius},${location})["name"]["sport"="swimming"];`
                : "";
  const filters = adventureInterest
    ? `nwr(around:${radius},${location})["name"]["amenity"~"^(climbing|escape_game|amusement_arcade|bowling_alley|ice_rink|sports_centre|boat_rental|bicycle_rental)$"];nwr(around:${radius},${location})["name"]["leisure"~"^(park|nature_reserve|sports_centre|climbing|water_park|adventure_park|escape_game|disc_golf_course|golf_course|marina|pitch|skatepark|swimming_pool)$"];nwr(around:${radius},${location})["name"]["tourism"~"^(viewpoint|theme_park)$"];nwr(around:${radius},${location})["name"]["sport"~"^(canoe|kayak|paddling|rowing|whitewater|climbing|cycling|mountain_biking|bmx|hiking|horse_riding|skiing|snowboarding|surfing|sailing|skateboarding|roller_skating|swimming)$"];`
    : studyInterest
      ? `nwr(around:${radius},${location})["name"]["amenity"~"^(library|university|college|cafe|coworking_space|community_centre)$"];nwr(around:${radius},${location})["name"]["shop"="books"];nwr(around:${radius},${location})["name"]["leisure"~"^(park|garden)$"];`
      : `nwr(around:${radius},${location})["name"]["amenity"~"^(library|university|college|cafe|coworking_space|arts_centre|community_centre|museum|climbing|escape_game|amusement_arcade|bowling_alley|theatre|cinema)$"];nwr(around:${radius},${location})["name"]["leisure"~"^(park|garden|nature_reserve|sports_centre|climbing|water_park|adventure_park|escape_game)$"];nwr(around:${radius},${location})["name"]["tourism"~"^(museum|gallery|attraction|viewpoint|artwork|theme_park)$"];nwr(around:${radius},${location})["name"]["historic"];nwr(around:${radius},${location})["name"]["shop"="books"];`;
  return `[out:json][timeout:18];(${refinedActivity || filters});out center tags 120;`;
}

export function validateNearbySearchInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NearbyApiError(400, "invalid_input", "Nearby search input must be a JSON object.");
  }
  const { latitude, longitude, radius, interests, refinement = "" } = value;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new NearbyApiError(400, "invalid_input", "Latitude must be a number between -90 and 90.");
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new NearbyApiError(400, "invalid_input", "Longitude must be a number between -180 and 180.");
  }
  if (typeof radius !== "number" || radius !== NEARBY_RADIUS_METERS) {
    throw new NearbyApiError(400, "invalid_input", `Radius must be exactly ${NEARBY_RADIUS_METERS} metres.`);
  }
  if (typeof interests !== "string" || interests.length > MAX_TEXT_LENGTH) {
    throw new NearbyApiError(400, "invalid_input", `Interests must be text no longer than ${MAX_TEXT_LENGTH} characters.`);
  }
  if (typeof refinement !== "string" || refinement.length > MAX_TEXT_LENGTH) {
    throw new NearbyApiError(400, "invalid_input", `Refinement must be text no longer than ${MAX_TEXT_LENGTH} characters.`);
  }
  return { latitude, longitude, radius, interests, refinement };
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function configuredUserAgent(value = process.env.OVERPASS_USER_AGENT ?? DEFAULT_OVERPASS_USER_AGENT) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new NearbyApiError(
      503,
      "configuration_required",
      "Nearby search is not configured. Set OVERPASS_USER_AGENT to a truthful Wayfarer identifier that includes the real project URL or contact information.",
    );
  }
  return value.trim();
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedDelay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requestedDelay) && requestedDelay >= 0) {
      return requestedDelay <= MAX_RETRY_DELAY_MS ? Math.max(250, requestedDelay) : null;
    }
  }
  return BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1);
}

async function readLimitedErrorBody(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BODY_BYTES - size;
      const chunk = value.subarray(0, remaining);
      chunks.push(Buffer.from(chunk));
      size += chunk.byteLength;
      if (chunk.byteLength < value.byteLength || size === MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function classifyUpstreamError(status, body) {
  const message = body.toLowerCase();
  if (status === 429 || /\b(?:rate[- ]?limit(?:ed|ing)?|too many requests)\b/.test(message)) return "rate_limit";
  const requiresIdentification = /\buser[- ]agent\b|\bcontact information\b|\bidentification string\b/.test(message) &&
    /\b(?:please|must|required|provide|include|missing|valid|invalid|rejected|identify)\b/.test(message);
  if (requiresIdentification) return "user_agent_rejected";
  if (/\b(?:parse error|syntax error|invalid query)\b/.test(message)) return "invalid_query";
  if (/\b(?:query timed out|timed out in "query"|ran out of memory|memory limit exceeded)\b/.test(message)) {
    return "query_limit";
  }
  return "upstream_failure";
}

async function readLimitedResponse(response) {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new NearbyApiError(502, "invalid_response", "OpenStreetMap returned a response that was too large.");
  }
  if (!response.body) {
    throw new NearbyApiError(502, "invalid_response", "OpenStreetMap returned an empty response.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new NearbyApiError(502, "invalid_response", "OpenStreetMap returned a response that was too large.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateOverpassPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.elements) || payload.elements.length > 250) {
    throw new NearbyApiError(502, "invalid_response", "OpenStreetMap returned place data in an unexpected format.");
  }
  for (const element of payload.elements) {
    if (!element || typeof element !== "object" ||
      !["node", "way", "relation"].includes(element.type) ||
      !Number.isSafeInteger(element.id) ||
      (element.tags !== undefined && (!element.tags || typeof element.tags !== "object" || Array.isArray(element.tags) ||
        Object.values(element.tags).some((tag) => typeof tag !== "string")))) {
      throw new NearbyApiError(502, "invalid_response", "OpenStreetMap returned place data in an unexpected format.");
    }
  }
  return payload.elements;
}

async function fetchUpstream(endpoint, query, { fetchImpl, signal, timeoutMs, userAgent }) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromClient = () => controller.abort(signal.reason);
  if (signal.aborted) throw new NearbyApiError(499, "cancelled", "Nearby search was cancelled.");
  signal.addEventListener("abort", abortFromClient, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
        "User-Agent": userAgent,
      },
      body: `data=${encodeURIComponent(query)}`,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { response, errorBody: await readLimitedErrorBody(response) };
    }
    let payload;
    try {
      payload = JSON.parse(await readLimitedResponse(response));
    } catch (error) {
      if (error instanceof NearbyApiError) throw error;
      if (error instanceof SyntaxError) {
        throw new NearbyApiError(502, "invalid_response", "OpenStreetMap returned malformed place data.");
      }
      throw error;
    }
    return { response, elements: validateOverpassPayload(payload) };
  } catch (error) {
    if (signal.aborted) throw new NearbyApiError(499, "cancelled", "Nearby search was cancelled.");
    if (error instanceof NearbyApiError) throw error;
    if (timedOut) throw new NearbyApiError(504, "timeout", "The OpenStreetMap place search timed out.", true);
    if (isAbortError(error)) throw new NearbyApiError(504, "timeout", "The OpenStreetMap place search timed out.", true);
    throw new NearbyApiError(502, "upstream_failure", "Could not connect to OpenStreetMap.", true);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortFromClient);
  }
}

export async function requestNearbyElements(input, {
  fetchImpl = globalThis.fetch,
  signal = new AbortController().signal,
  sleep = delay,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  userAgent,
} = {}) {
  const requestUserAgent = configuredUserAgent(userAgent);
  const query = buildNearbyQuery(input);
  const upstreamAttempts = [];
  let lastError = new NearbyApiError(502, "upstream_failure", "OpenStreetMap is temporarily unavailable.", true);

  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt += 1) {
    if (signal.aborted) throw new NearbyApiError(499, "cancelled", "Nearby search was cancelled.");
    const endpoint = OVERPASS_ENDPOINTS[attempt];
    try {
      const { response, elements, errorBody } = await fetchUpstream(endpoint, query, {
        fetchImpl,
        signal,
        timeoutMs,
        userAgent: requestUserAgent,
      });
      if (!response.ok) {
        const code = classifyUpstreamError(response.status, errorBody);
        upstreamAttempts.push({ host: new URL(endpoint).host, status: response.status, code });
        if (code === "user_agent_rejected") {
          throw new NearbyApiError(
            503,
            "configuration_required",
            "An Overpass instance requires a valid identifying User-Agent. Set OVERPASS_USER_AGENT to include the real project URL or contact information.",
            false,
            upstreamAttempts,
          );
        }
        if (code === "invalid_query") {
          throw new NearbyApiError(
            502,
            "invalid_query",
            "OpenStreetMap rejected the nearby search query. The query was not changed automatically.",
            false,
            upstreamAttempts,
          );
        }
        if (!TRANSIENT_STATUSES.has(response.status)) {
          throw new NearbyApiError(502, "upstream_failure", `OpenStreetMap returned HTTP ${response.status}.`, false, upstreamAttempts);
        }
        if (code === "rate_limit") {
          lastError = new NearbyApiError(503, "rate_limit", "OpenStreetMap is rate-limiting nearby searches.", true, upstreamAttempts);
          const waitMs = retryDelay(response, attempt);
          if (waitMs === null) break;
          if (attempt < OVERPASS_ENDPOINTS.length - 1) await sleep(waitMs, undefined, { signal });
          continue;
        }
        lastError = new NearbyApiError(502, "upstream_failure", `OpenStreetMap returned HTTP ${response.status}.`, true, upstreamAttempts);
        if (attempt < OVERPASS_ENDPOINTS.length - 1) await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1), undefined, { signal });
        continue;
      }

      return elements;
    } catch (error) {
      if (signal.aborted || (error instanceof NearbyApiError && error.code === "cancelled")) {
        throw new NearbyApiError(499, "cancelled", "Nearby search was cancelled.");
      }
      const errorAttempts = error instanceof NearbyApiError ? error.upstreamAttempts : undefined;
      if (!errorAttempts) {
        upstreamAttempts.push({
          host: new URL(endpoint).host,
          code: error instanceof NearbyApiError ? error.code : "upstream_failure",
        });
        if (error instanceof NearbyApiError) error.upstreamAttempts = upstreamAttempts;
      }
      if (error instanceof NearbyApiError && !error.retryable) throw error;
      if (error instanceof NearbyApiError && error.code === "invalid_response") throw error;
      lastError = error instanceof NearbyApiError
        ? error
        : new NearbyApiError(502, "upstream_failure", "Could not connect to OpenStreetMap.", true, upstreamAttempts);
      if (attempt < OVERPASS_ENDPOINTS.length - 1) {
        try {
          await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1), undefined, { signal });
        } catch {
          if (signal.aborted) throw new NearbyApiError(499, "cancelled", "Nearby search was cancelled.");
          throw error;
        }
      }
    }
  }

  if (upstreamAttempts.length > 0 && upstreamAttempts.every(({ code }) => code === "rate_limit")) {
    throw new NearbyApiError(
      503,
      "rate_limit",
      "All available OpenStreetMap services are rate-limiting nearby searches. Try again later or use a saved/manual place.",
      true,
      upstreamAttempts,
    );
  }
  if (lastError.code === "timeout") {
    throw new NearbyApiError(504, "timeout", "Nearby place search timed out. Your entered details are unchanged; try again shortly.", true, upstreamAttempts);
  }
  throw new NearbyApiError(502, "upstream_failure", "Nearby place search is temporarily unavailable. Your entered details are unchanged; try again shortly or use a saved/manual place.", true, upstreamAttempts);
}

function sendJson(response, status, body, closeConnection = false) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(closeConnection ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(body));
}

function readRequestJson(request, timeoutMs = REQUEST_BODY_TIMEOUT_MS) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new NearbyApiError(415, "invalid_input", "Nearby search requests must use application/json.");
  }
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new NearbyApiError(413, "invalid_input", "Nearby search request is too large.");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        fail(new NearbyApiError(413, "invalid_input", "Nearby search request is too large."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        settled = true;
        cleanup();
        resolve(parsed);
      } catch {
        fail(new NearbyApiError(400, "invalid_input", "Nearby search request must contain valid JSON."));
      }
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new NearbyApiError(400, "invalid_input", "Nearby search request was interrupted."));
    const timer = setTimeout(() => {
      fail(new NearbyApiError(408, "timeout", "Nearby search request timed out while receiving its body."));
    }, timeoutMs);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

export function createOverpassHandler(options = {}) {
  return async function handleOverpassRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/nearby") return false;
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: { code: "invalid_input", message: "Use POST for nearby searches.", retryable: false } });
      return true;
    }

    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    request.once("aborted", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) abortRequest();
    });

    let validatedInput;
    try {
      const input = validateNearbySearchInput(await readRequestJson(request, options.requestBodyTimeoutMs));
      validatedInput = input;
      const elements = await requestNearbyElements(input, { ...options, signal: controller.signal });
      if (elements.length === 0 && await sendGeoapifyFallback(input, response, controller.signal, options)) return true;
      if (!response.destroyed) {
        sendJson(response, 200, {
          outcome: elements.length === 0 ? "no_results" : "ok",
          provider: "openstreetmap",
          elements,
        });
      }
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return true;
      const apiError = error instanceof NearbyApiError
        ? error
        : new NearbyApiError(500, "upstream_failure", "Nearby place search failed unexpectedly.", false);
      if (validatedInput && apiError.code !== "cancelled" && apiError.code !== "invalid_input" && await sendGeoapifyFallback(validatedInput, response, controller.signal, options)) return true;
      if (apiError.upstreamAttempts) {
        const logger = options.logger ?? console;
        logger.warn("Nearby search upstream attempts failed.", {
          code: apiError.code,
          attempts: apiError.upstreamAttempts,
        });
      }
      const closeConnection = [408, 413, 415].includes(apiError.status);
      sendJson(response, apiError.status, {
        error: {
          code: apiError.code,
          message: apiError.message,
          retryable: apiError.retryable,
          ...(apiError.upstreamAttempts ? { upstreamAttempts: apiError.upstreamAttempts } : {}),
        },
      }, closeConnection);
      if (closeConnection) response.once("finish", () => request.destroy());
    } finally {
      request.removeListener("aborted", abortRequest);
    }
    return true;
  };
}

async function sendGeoapifyFallback(input, response, signal, options) {
  const apiKey = options.geoapifyApiKey ?? process.env.GEOAPIFY_API_KEY;
  if (typeof apiKey !== "string" || !apiKey.trim() || response.destroyed) return false;
  try {
    const places = await requestGeoapifyPlaces(input, { ...options, apiKey, signal });
    if (response.destroyed) return true;
    sendJson(response, 200, { outcome: places.length ? "ok" : "no_results", provider: "geoapify", places });
    return true;
  } catch (error) {
    if (signal.aborted || response.destroyed) return true;
    const logger = options.logger ?? console;
    logger.warn("Geoapify fallback search failed.", { code: error instanceof Error ? "provider_failure" : "unknown_failure" });
    return false;
  }
}
