const GEOAPIFY_URL = "https://api.geoapify.com/v2/places";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESULTS = 80;

const CATEGORY_GROUPS = Object.freeze({
  green: ["leisure.park", "natural.forest", "natural.protected_area"],
  quiet: ["education.library", "catering.cafe", "commercial.books"],
  culture: ["entertainment.museum", "entertainment.culture", "tourism.attraction"],
  food: ["catering.cafe", "catering.restaurant", "catering.fast_food"],
  active: ["sport", "entertainment.activity_park", "leisure.playground"],
});

function categoriesFor(input) {
  const refinement = input.refinement.toLowerCase();
  if (/kayak|canoe|paddl|rowing|whitewater|swim/.test(refinement)) return ["sport", "waterway.whitewater"];
  if (/climb|bould|zip.?line/.test(refinement)) return ["sport", "entertainment.activity_park.climbing"];
  if (/cycl|bik/.test(refinement)) return ["sport"];
  if (/hike|walk|trail/.test(refinement)) return ["leisure.park", "natural.forest"];
  const groups = input.interests.split(",").map((item) => item.trim());
  const categories = groups.flatMap((group) => CATEGORY_GROUPS[group] ?? []);
  return [...new Set(categories.length ? categories : CATEGORY_GROUPS.green.concat(CATEGORY_GROUPS.quiet))];
}

function categoryLabel(properties) {
  const categories = Array.isArray(properties.categories) ? properties.categories : [];
  const candidate = categories.find((value) => typeof value === "string" && !value.startsWith("building."));
  return candidate ? candidate.split(".").slice(-2).join(" · ").replaceAll("_", " ") : "Nearby place";
}

async function readLimitedJson(response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("Geoapify returned a response that was too large.");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Geoapify returned a response that was too large.");
  return JSON.parse(text);
}

export async function requestGeoapifyPlaces(input, {
  apiKey = process.env.GEOAPIFY_API_KEY,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Geoapify fallback requires GEOAPIFY_API_KEY on the application server.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw new Error("Nearby search was cancelled.");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(GEOAPIFY_URL);
    url.searchParams.set("categories", categoriesFor(input).join(","));
    url.searchParams.set("filter", `circle:${input.longitude},${input.latitude},${input.radius}`);
    url.searchParams.set("bias", `proximity:${input.longitude},${input.latitude}`);
    url.searchParams.set("limit", String(MAX_RESULTS));
    url.searchParams.set("lang", "en");
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "x-api-key": apiKey },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Geoapify Places returned HTTP ${response.status}.`);
    const payload = await readLimitedJson(response);
    if (!payload || !Array.isArray(payload.features) || payload.features.length > MAX_RESULTS) {
      throw new Error("Geoapify returned place data in an unexpected format.");
    }
    const seen = new Set();
    return payload.features.flatMap((feature) => {
      const properties = feature?.properties;
      const coordinates = feature?.geometry?.coordinates;
      if (!properties || typeof properties !== "object" || !Array.isArray(coordinates) || coordinates.length < 2) return [];
      const longitude = Number(coordinates[0]);
      const latitude = Number(coordinates[1]);
      const name = typeof properties.name === "string" ? properties.name.trim() : "";
      const id = typeof properties.place_id === "string" ? properties.place_id : "";
      if (!name || !id || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || seen.has(id)) return [];
      seen.add(id);
      const category = categoryLabel(properties);
      const locality = [properties.city, properties.state, properties.country].filter((value) => typeof value === "string" && value.trim()).join(", ");
      return [{
        id: `geoapify-${id}`,
        name,
        latitude,
        longitude,
        category,
        locality,
        interests: category,
        details: `Geoapify lists this place under ${category}. Listing data may be incomplete; check the place directly before you go.`,
        mapUrl: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`,
      }];
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
