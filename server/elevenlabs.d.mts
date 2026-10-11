import type { IncomingMessage, ServerResponse } from "node:http";

export function createElevenLabsHandler(options?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
