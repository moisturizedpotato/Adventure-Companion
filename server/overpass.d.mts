import type { IncomingMessage, ServerResponse } from "node:http";

export function createOverpassHandler(options?: Record<string, unknown>): (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;
