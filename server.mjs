import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createOverpassHandler } from "./server/overpass.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(ROOT, "dist");
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
]);

async function serveStatic(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  const filePath = resolve(DIST, `.${pathname}`);
  if (filePath !== DIST && !filePath.startsWith(`${DIST}${sep}`)) {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  let target = filePath;
  try {
    if (!(await stat(target)).isFile()) target = resolve(DIST, "index.html");
  } catch {
    target = resolve(DIST, "index.html");
  }
  let contents;
  try {
    contents = await readFile(target);
  } catch {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Application build not found. Run npm run build first.");
    return;
  }

  const asset = target.startsWith(resolve(DIST, "assets") + sep);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extname(target)) ?? "application/octet-stream",
    "Content-Length": contents.length,
    "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : contents);
}

const handleOverpassRequest = createOverpassHandler();
const server = createServer(async (request, response) => {
  try {
    if (await handleOverpassRequest(request, response)) return;
    if (new URL(request.url, "http://localhost").pathname.startsWith("/api/")) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { code: "not_found", message: "API route not found.", retryable: false } }));
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    console.error("Application request failed.", error);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Internal server error");
  }
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
server.listen(port, host, () => {
  console.log(`Wayfarer listening on http://${host}:${port}`);
});
