import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { parseMapCoordinates } from "../src/mapCoordinates.mjs";
import {
  buildNearbyQuery,
  createOverpassHandler,
  NEARBY_RADIUS_METERS,
  OVERPASS_ENDPOINTS,
  NearbyApiError,
  requestNearbyElements,
  validateNearbySearchInput,
} from "./overpass.mjs";

const validInput = {
  latitude: 42.3601,
  longitude: -71.0589,
  radius: NEARBY_RADIUS_METERS,
  interests: "adventure",
  refinement: "",
};
const TEST_USER_AGENT = "Wayfarer test client (tests only)";

test("parses OpenStreetMap map-centre hash links", () => {
  assert.deepEqual(
    parseMapCoordinates("https://www.openstreetmap.org/#map=15/42.3601/-71.0589"),
    { latitude: 42.3601, longitude: -71.0589 },
  );
});

test("parses OpenStreetMap shared links with mlat and mlon", () => {
  assert.deepEqual(
    parseMapCoordinates("https://www.openstreetmap.org/?mlat=42.3601&mlon=-71.0589#map=15/0/0"),
    { latitude: 42.3601, longitude: -71.0589 },
  );
});

test("parses typed coordinate pairs and rejects malformed or out-of-range values", () => {
  assert.deepEqual(parseMapCoordinates("42.3601, -71.0589"), { latitude: 42.3601, longitude: -71.0589 });
  assert.equal(parseMapCoordinates("91, 0"), null);
  assert.equal(parseMapCoordinates("0, 181"), null);
  assert.equal(parseMapCoordinates("not a map link"), null);
  assert.equal(parseMapCoordinates(""), null);
});

test("validates coordinates, the fixed search radius, and text bounds", () => {
  for (const input of [
    { ...validInput, latitude: 90.1 },
    { ...validInput, longitude: -180.1 },
    { ...validInput, latitude: Number.NaN },
    { ...validInput, radius: 3001 },
    { ...validInput, interests: "x".repeat(301) },
    { ...validInput, refinement: 42 },
  ]) {
    assert.throws(() => validateNearbySearchInput(input), NearbyApiError);
  }
  assert.deepEqual(validateNearbySearchInput(validInput), validInput);
});

test("builds a bounded, rounded, interest-filtered Overpass query from validated input", () => {
  const query = buildNearbyQuery(validInput);
  assert.match(query, /^\[out:json\]\[timeout:12\];/);
  assert.match(query, /around:3000,42\.360,-71\.059/);
  assert.match(query, /"sport"~/);
  assert.match(query, /out center tags 250;$/);

  const maliciousText = buildNearbyQuery({
    ...validInput,
    interests: '");out geom;/*',
    refinement: '");node;/*',
  });
  assert.doesNotMatch(maliciousText, /out geom|node;/);
});

async function startApiServer(options = {}) {
  const handler = createOverpassHandler({ userAgent: TEST_USER_AGENT, ...options });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function postNearby(server, input = validInput, headers = {}) {
  return fetch(`${server.url}/api/nearby`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}

test("nearby endpoint validates input before any upstream request", async (t) => {
  let upstreamCalls = 0;
  const server = await startApiServer({ fetchImpl: async () => {
    upstreamCalls += 1;
    return new Response('{"elements":[]}', { status: 200 });
  } });
  t.after(() => server.close());

  const response = await postNearby(server, { ...validInput, latitude: 91 });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "invalid_input",
      message: "Latitude must be a number between -90 and 90.",
      retryable: false,
    },
  });
  assert.equal(upstreamCalls, 0);
});

test("requires an explicitly configured Overpass User-Agent before making a request", async (t) => {
  let upstreamCalls = 0;
  const server = await startApiServer({
    userAgent: "",
    fetchImpl: async () => {
      upstreamCalls += 1;
      return Response.json({ elements: [] });
    },
  });
  t.after(() => server.close());

  const response = await postNearby(server);
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.error.code, "configuration_required");
  assert.match(payload.error.message, /OVERPASS_USER_AGENT/);
  assert.equal(upstreamCalls, 0);
});

test("nearby endpoint rejects non-JSON and unsupported methods", async (t) => {
  const server = await startApiServer();
  t.after(() => server.close());

  const wrongContentType = await fetch(`${server.url}/api/nearby`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal((await wrongContentType.json()).error.code, "invalid_input");

  const wrongMethod = await fetch(`${server.url}/api/nearby`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("Allow"), "POST");
});

test("nearby endpoint rejects oversized requests", async (t) => {
  const server = await startApiServer();
  t.after(() => server.close());

  const response = await postNearby(server, { ...validInput, unused: "x".repeat(17 * 1024) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "invalid_input");
});

test("reports safe upstream attempt diagnostics after bounded retries", async (t) => {
  const warnings = [];
  const server = await startApiServer({
    fetchImpl: async () => new Response("", { status: 504 }),
    sleep: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });
  t.after(() => server.close());

  const response = await postNearby(server);
  const payload = await response.json();
  const attempts = OVERPASS_ENDPOINTS.map((endpoint) => ({
    host: new URL(endpoint).host,
    status: 504,
    code: "upstream_failure",
  }));
  assert.equal(response.status, 502);
  assert.deepEqual(payload.error.upstreamAttempts, attempts);
  assert.deepEqual(warnings, [[
    "Nearby search upstream attempts failed.",
    { code: "upstream_failure", attempts },
  ]]);
  assert.doesNotMatch(JSON.stringify(warnings), /42\.3601|-71\.0589|around:/);
});

test("classifies known Overpass errors without exposing or logging response bodies", async (t) => {
  const warnings = [];
  const errorBody = '<remark>parse error near 51.507,-0.127; query interest adventure</remark>';
  const server = await startApiServer({
    fetchImpl: async () => new Response(errorBody, { status: 500 }),
    sleep: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });
  t.after(() => server.close());

  const response = await postNearby(server);
  const payload = await response.json();
  assert.equal(response.status, 502);
  assert.equal(payload.error.code, "invalid_query");
  assert.deepEqual(payload.error.upstreamAttempts, [{
    host: new URL(OVERPASS_ENDPOINTS[0]).host,
    status: 500,
    code: "invalid_query",
  }]);
  assert.doesNotMatch(JSON.stringify(payload), /51\.507|-0\.127|adventure|parse error/);
  assert.doesNotMatch(JSON.stringify(warnings), /51\.507|-0\.127|adventure|parse error/);

  const userAgentServer = await startApiServer({
    fetchImpl: async () => new Response("Please use an identifying User-Agent and contact information.", { status: 403 }),
    sleep: async () => {},
  });
  t.after(() => userAgentServer.close());

  const userAgentResponse = await postNearby(userAgentServer);
  const userAgentPayload = await userAgentResponse.json();
  assert.equal(userAgentResponse.status, 503);
  assert.equal(userAgentPayload.error.code, "configuration_required");
  assert.match(userAgentPayload.error.message, /OVERPASS_USER_AGENT/);
  assert.deepEqual(userAgentPayload.error.upstreamAttempts[0], {
    host: new URL(OVERPASS_ENDPOINTS[0]).host,
    status: 403,
    code: "user_agent_rejected",
  });
  assert.doesNotMatch(JSON.stringify(userAgentPayload), /Please use an identifying/);
});

test("nearby endpoint bounds the time allowed to receive a request body", async (t) => {
  let upstreamCalls = 0;
  const server = await startApiServer({
    requestBodyTimeoutMs: 10,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return Response.json({ elements: [] });
    },
  });
  t.after(() => server.close());

  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(`${server.url}/api/nearby`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.write('{"latitude":');
  });
  assert.equal(response.status, 408);
  assert.equal(JSON.parse(response.body).error.code, "timeout");
  assert.equal(upstreamCalls, 0);
});

test("retries transient upstream failures sequentially and returns successful results", async () => {
  const requested = [];
  const delays = [];
  const results = [{ type: "node", id: 5, tags: { name: "Example Park", leisure: "park" } }];
  const elements = await requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    fetchImpl: async (endpoint, options) => {
      requested.push(endpoint);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["User-Agent"], TEST_USER_AGENT);
      if (requested.length === 1) return new Response("", { status: 504 });
      if (requested.length === 2) return new Response("", { status: 503 });
      return Response.json({ elements: results });
    },
    sleep: async (ms) => delays.push(ms),
  });
  assert.deepEqual(elements, results);
  assert.deepEqual(requested, OVERPASS_ENDPOINTS);
  assert.deepEqual(delays, [250, 500]);
});

test("respects a bounded Retry-After on rate limits", async () => {
  const delays = [];
  let attempts = 0;
  await assert.rejects(requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    fetchImpl: async () => {
      attempts += 1;
      return new Response("", { status: 429, headers: { "Retry-After": "1" } });
    },
    sleep: async (ms) => delays.push(ms),
  }), (error) => error.code === "rate_limit");
  assert.equal(attempts, OVERPASS_ENDPOINTS.length);
  assert.deepEqual(delays, [1000, 1000]);

  attempts = 0;
  delays.length = 0;
  await assert.rejects(requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    fetchImpl: async () => {
      attempts += 1;
      return new Response("", { status: 429, headers: { "Retry-After": "60" } });
    },
    sleep: async (ms) => delays.push(ms),
  }), (error) => error.code === "rate_limit");
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("upstream timeout has a finite attempt count and does not hang", async () => {
  let attempts = 0;
  await assert.rejects(requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    timeoutMs: 10,
    fetchImpl: (_, { signal }) => new Promise((_, reject) => {
      attempts += 1;
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
    sleep: async () => {},
  }), (error) => error.code === "timeout");
  assert.equal(attempts, OVERPASS_ENDPOINTS.length);
});

test("upstream response-body reads are covered by the timeout and size limit", async () => {
  let attempts = 0;
  await assert.rejects(requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    timeoutMs: 10,
    fetchImpl: (_, { signal }) => {
      attempts += 1;
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
    sleep: async () => {},
  }), (error) => error.code === "timeout");
  assert.equal(attempts, OVERPASS_ENDPOINTS.length);

  await assert.rejects(requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    fetchImpl: async () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(3 * 1024 * 1024 + 1) },
    }),
    sleep: async () => {},
  }), (error) => error.code === "invalid_response");
});

test("client cancellation stops retries and propagates a cancellation error", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    signal: controller.signal,
    fetchImpl: (_, { signal }) => new Promise((_, reject) => {
      attempts += 1;
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
    sleep: async () => {},
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "cancelled");
  assert.equal(attempts, 1);
});

test("returns structured invalid-response errors for malformed Overpass responses", async () => {
  await assert.rejects(requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    fetchImpl: async () => new Response("not json", { status: 200 }),
    sleep: async () => {},
  }), (error) => error.code === "invalid_response");

  await assert.rejects(requestNearbyElements(validInput, {
    userAgent: TEST_USER_AGENT,
    fetchImpl: async () => Response.json({ elements: [{ type: "area", id: "bad" }] }),
    sleep: async () => {},
  }), (error) => error.code === "invalid_response");
});

test("represents a valid empty result as no_results", async (t) => {
  const server = await startApiServer({
    fetchImpl: async () => Response.json({ elements: [] }),
    sleep: async () => {},
  });
  t.after(() => server.close());

  const response = await postNearby(server);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { outcome: "no_results", elements: [] });
});
