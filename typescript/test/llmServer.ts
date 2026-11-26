import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import { buildLlmClient } from "../src/llm/index.js";

/**
 * Call an LLM provider through a local server that answers every request with one HTTP status.
 *
 * @param status (number): the HTTP status every request answers with.
 * @return (Promise<{ base_url: string; message: string; error: Error }>): the URI, the error text, and the error.
 */
export async function callProviderMessage(
  status: number,
): Promise<{ base_url: string; message: string; error: Error }> {
  const server = createServer((_req, res) => res.writeHead(status, { "Content-Type": "application/json" }).end("{}"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const base_url = `http://127.0.0.1:${port}`;
    const llm = buildLlmClient({ provider: "openai", model: "m", api_key: "k", base_url, max_retries: 0 });
    try {
      await llm.generate({ system: "", user: "x", output: z.object({ ok: z.boolean() }) });
    } catch (exc) {
      if (exc instanceof Error) return { base_url, message: exc.message, error: exc };
      const error = new Error(String(exc));
      return { base_url, message: error.message, error };
    }
    throw new Error(`callProviderMessage(${status}) returned instead of raising`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
