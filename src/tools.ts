/**
 * Pieces shared by the local (stdio, paying) and hosted (HTTP, non-paying) MCP servers: the two free tools, the
 * quote call, argument validation against a service tool's schema, the paid URL, and the text result helper.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { fetchCatalog, type Catalog, type ServiceTool } from "./catalog.js";
import { readBody } from "./pay.js";

export const CATALOG_TOOL = "x420_catalog";
export const QUOTE_TOOL = "x420_quote";

export const text = (value: unknown, isError = false): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

/** The rails a quote may name; x402 is the one this server pays on. */
export const railsOf = (catalog: Catalog): string[] => (catalog.rails.length ? catalog.rails : ["x402"]);
export const defaultRail = (rails: string[]): string => (rails.includes("x402") ? "x402" : rails[0]);

/** `x420_catalog` and `x420_quote`, identical on both servers. */
export function freeTools(origin: string, catalog: Catalog): Tool[] {
  const rails = railsOf(catalog);
  return [
    {
      name: CATALOG_TOOL,
      description: `Free. Fetches X420's live service catalog from ${origin}/a2a/catalog: every service with its id, price in USD, input parameters and deliverable. Use it to see what the x420_* tools cost before calling one.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    {
      name: QUOTE_TOOL,
      description: `Free. Asks X420 for a price quote (POST ${origin}/a2a/quote) for one service and input: amount in USD, currency, rail, pay-to address, nonce and expiry. A quote costs nothing and does not place an order.`,
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: `service id from the catalog, e.g. ${catalog.services[0]?.id ?? "sitescan.check"}` },
          input: { type: "object", description: "the service's input parameters (string values), exactly as you would pass to its tool", additionalProperties: { type: "string" } },
          rail: { type: "string", enum: rails, description: `payment rail; default ${defaultRail(rails)}` },
        },
        required: ["service"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ];
}

/** Run one of the free tools; returns null when `name` is neither. */
export async function callFreeTool(name: string, args: Record<string, unknown>, origin: string, catalog: Catalog, fetchImpl: typeof fetch): Promise<CallToolResult | null> {
  if (name === CATALOG_TOOL) return text(await fetchCatalog(origin, fetchImpl));
  if (name === QUOTE_TOOL) return text(await quote(origin, fetchImpl, args, railsOf(catalog)));
  return null;
}

export async function quote(origin: string, fetchImpl: typeof fetch, args: Record<string, unknown>, rails: string[]): Promise<unknown> {
  const service = String(args.service ?? "");
  if (!service) throw new Error("quote needs a service id");
  const rail = args.rail ? String(args.rail) : defaultRail(rails);
  const input = args.input && typeof args.input === "object" ? args.input : {};
  const res = await fetchImpl(`${origin}/a2a/quote`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ service, input, rail }) });
  const body = await readBody(res);
  if (!res.ok) throw new Error(`quote answered HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

/**
 * Check a call's arguments against the service tool's schema. Either the names of the missing required parameters,
 * or the paid URL (`<origin>/a2a/x402/<id>?<params>`, known parameters only, optional ones only when given).
 */
export function serviceRequest(origin: string, t: ServiceTool, args: Record<string, unknown>): { missing: string[] } | { url: string; params: Record<string, string> } {
  const missing = t.inputSchema.required.filter((k) => !present(args[k]));
  if (missing.length) return { missing };
  const params: Record<string, string> = {};
  for (const k of Object.keys(t.inputSchema.properties)) if (present(args[k])) params[k] = String(args[k]);
  const qs = new URLSearchParams(params);
  return { url: `${origin}/a2a/x402/${encodeURIComponent(t.service.id)}${qs.size ? `?${qs}` : ""}`, params };
}

export const missingInputResult = (t: ServiceTool, missing: string[]): CallToolResult =>
  text(`missing required input: ${missing.join(", ")} (${t.service.id} takes ${Object.keys(t.inputSchema.properties).join(", ")})`, true);
