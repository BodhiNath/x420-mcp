/**
 * X420's service catalog as the MCP server sees it. The catalog is fetched live from the seller when the server
 * starts (GET /a2a/catalog) and never hard-coded, so every service X420 adds becomes a tool on the next start. One
 * tool per service, named `x420_<id>` with dots mapped to underscores; the input schema is built from the catalog's
 * input map (every parameter is a string carrying the seller's own description; a parameter whose description
 * mentions "default" or "optional" is not required).
 */
import { DEFAULT_MAX_USD, MAX_ENV } from "./pay.js";

export interface CatalogService {
  id: string;
  name: string;
  description: string;
  category?: string;
  price_usd: number;
  input: Record<string, string>;
  output?: string;
  max_ms?: number;
  examples?: { input?: Record<string, unknown>; output?: unknown };
}
export interface Catalog { agent: string; rails: string[]; services: CatalogService[] }

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, { type: "string"; description: string }>;
  required: string[];
  additionalProperties: boolean;
};
export interface ServiceTool { name: string; service: CatalogService; description: string; inputSchema: ToolInputSchema }

export function fmtUsd(n: number): string { const s = n.toFixed(4).replace(/0+$/, ""); const [i, d = ""] = s.split("."); return `$${i}.${d.padEnd(2, "0")}`; }
export const TOOL_PREFIX = "x420_";
/** `sitescan.check` -> `x420_sitescan_check`; anything outside the MCP tool-name alphabet also becomes `_`. */
export const toolName = (id: string): string => TOOL_PREFIX + id.replace(/\./g, "_").replace(/[^A-Za-z0-9_-]/g, "_");
export const isOptionalParam = (description: string): boolean => /\b(default|optional)\b/i.test(description);
export const trimOrigin = (origin: string): string => origin.replace(/\/+$/, "");

export async function fetchCatalog(origin: string, fetchImpl: typeof fetch = fetch): Promise<Catalog> {
  const url = `${trimOrigin(origin)}/a2a/catalog`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`catalog ${url} answered HTTP ${res.status}`);
  const c = (await res.json()) as Partial<Catalog>;
  if (!Array.isArray(c.services)) throw new Error(`catalog ${url} carries no services array`);
  const services = c.services.filter((s): s is CatalogService => Boolean(s) && typeof s.id === "string" && s.id.length > 0);
  return { agent: String(c.agent ?? ""), rails: Array.isArray(c.rails) ? c.rails.map(String) : [], services };
}

/** What the seller's Agent Card (`/.well-known/agent.json`, `payments` block) says about getting paid. */
export interface Payments { network: string; network_caip2: string | null; pay_to: string | null; currency: string }

export async function fetchAgentCardPayments(origin: string, fetchImpl: typeof fetch = fetch): Promise<Payments> {
  const url = `${trimOrigin(origin)}/.well-known/agent.json`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`agent card ${url} answered HTTP ${res.status}`);
  const card = (await res.json()) as { payments?: { network?: string; network_caip2?: string; pay_to?: string; currency?: string } };
  const p = card.payments ?? {};
  return { network: p.network ?? "base", network_caip2: p.network_caip2 ?? null, pay_to: p.pay_to ?? null, currency: p.currency ?? "USDC" };
}

export function serviceTool(s: CatalogService): ServiceTool {
  const input = s.input && typeof s.input === "object" ? s.input : {};
  const properties: ToolInputSchema["properties"] = {};
  const required: string[] = [];
  for (const [k, d] of Object.entries(input)) {
    const description = String(d);
    properties[k] = { type: "string", description };
    if (!isOptionalParam(description)) required.push(k);
  }
  const price = Number(s.price_usd) || 0;
  const cost = price > 0
    ? `PAID: ${fmtUsd(price)} USDC per call, settled on Base via x402 from the wallet in X420_MCP_WALLET_PRIVATE_KEY (real money).`
    : "Free call.";
  const example = s.examples?.input ? ` Example input: ${JSON.stringify(s.examples.input)}.` : "";
  const capNote = price > DEFAULT_MAX_USD ? ` Above the default $${DEFAULT_MAX_USD.toFixed(2)} per-call cap: refused until ${MAX_ENV}=${Math.ceil(price)} (or higher) is set in the MCP server's environment.` : "";
  const description = `${s.name}: ${s.description} ${cost}${capNote} Returns: ${s.output ?? "JSON"} - the deliverable plus X420's signed receipt and the settlement transaction.${example}`;
  return { name: toolName(s.id), service: s, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
