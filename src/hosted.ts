/**
 * X420 MCP server (hosted, non-paying): the same tools as the local server, served over MCP Streamable HTTP for
 * directories that need a public endpoint (Glama, Smithery, the official registry's remote type). This process holds
 * no wallet and reads no key: a paid tool validates its inputs and returns PAYMENT INSTRUCTIONS (price, pay-to,
 * network, the x402 URL) instead of the deliverable. The caller pays with its own x402 client, or runs the local
 * `x420-mcp` with its own key to pay automatically.
 *
 * Stateless: a fresh Server + transport per HTTP request (`sessionIdGenerator: undefined`), so it mounts as
 * `app.all("/mcp", handler)` behind any proxy with no session affinity. The catalog and the seller's payment details
 * (from the Agent Card) are cached briefly so a burst of MCP requests does not re-read them every time.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { fetchAgentCardPayments, fetchCatalog, serviceTool, trimOrigin, type Catalog, type Payments, type ServiceTool } from "./catalog.js";
import { DEFAULT_MAX_USD, MAX_ENV } from "./pay.js";
import { CATALOG_TOOL, callFreeTool, freeTools, missingInputResult, serviceRequest, text } from "./tools.js";

export { fetchAgentCardPayments as fetchPayments } from "./catalog.js";
export type { Payments } from "./catalog.js";

export const HOSTED_SERVER_NAME = "x420-mcp-hosted";
export const HOSTED_SERVER_VERSION = "1.0.0";
export const DEFAULT_CACHE_MS = 60_000;
export const PAY_HOW = "GET the url; read PAYMENT-REQUIRED from the 402; retry with PAYMENT-SIGNATURE (x402 v2). Or run the local x420-mcp server with your own wallet key to pay automatically.";

export interface HostedOptions {
  origin: string;
  /** Catalog source; default GET <origin>/a2a/catalog. */
  catalog?: () => Promise<Catalog>;
  /** Payment details source; default the Agent Card at <origin>/.well-known/agent.json. */
  payments?: () => Promise<Payments>;
  fetchImpl?: typeof fetch;
  /** How long a fetched catalog/payments snapshot serves requests before it is refreshed. */
  cacheMs?: number;
}

export type HostedHandler = (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void>;

/** The hosted description: the same facts as the local tool, then what this endpoint actually returns. */
export function hostedDescription(t: ServiceTool): string {
  const s = t.service;
  const price = Number(s.price_usd) || 0;
  const capNote = price > DEFAULT_MAX_USD ? ` Note: the local x420-mcp refuses this service above its default $${DEFAULT_MAX_USD.toFixed(2)} per-call cap; set ${MAX_ENV}=${Math.ceil(price)} there to allow it.` : "";
  return `${s.name}: ${s.description} Price: $${price.toFixed(2)} USDC per call (x402 on Base). This hosted tool does NOT pay and does NOT return the deliverable: it validates the input and returns payment instructions (pay_to, network, price and the x402 URL to pay at). ${PAY_HOW} Deliverable once paid: ${s.output ?? "JSON"}.${capNote}`;
}

interface Snapshot { at: number; catalog: Catalog; payments: Payments; tools: Tool[]; serviceTools: Map<string, ServiceTool> }

export function createHostedMcpHandler(opts: HostedOptions): HostedHandler {
  const origin = trimOrigin(opts.origin);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cacheMs = opts.cacheMs ?? DEFAULT_CACHE_MS;
  const loadCatalog = opts.catalog ?? (() => fetchCatalog(origin, fetchImpl));
  const loadPayments = opts.payments ?? (() => fetchAgentCardPayments(origin, fetchImpl));

  let snap: Snapshot | null = null;
  let loading: Promise<Snapshot> | null = null;
  const snapshot = async (): Promise<Snapshot> => {
    if (snap && Date.now() - snap.at < cacheMs) return snap;
    if (!loading) {
      loading = (async () => {
        try {
          const [catalog, payments] = await Promise.all([loadCatalog(), loadPayments()]);
          const serviceTools = new Map<string, ServiceTool>();
          for (const s of catalog.services) { const t = serviceTool(s); serviceTools.set(t.name, t); }
          const tools: Tool[] = [
            ...freeTools(origin, catalog),
            ...[...serviceTools.values()].map((t): Tool => ({ name: t.name, description: hostedDescription(t), inputSchema: t.inputSchema, annotations: { title: t.service.name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } })),
          ];
          snap = { at: Date.now(), catalog, payments, tools, serviceTools };
          return snap;
        } catch (e) {
          if (snap) return snap; // a stale snapshot beats an outage
          throw e;
        } finally { loading = null; }
      })();
    }
    return loading;
  };

  const buildServer = (s: Snapshot): Server => {
    const server = new Server({ name: HOSTED_SERVER_NAME, version: HOSTED_SERVER_VERSION }, { capabilities: { tools: {} }, instructions: `X420 agent services (${s.catalog.agent || origin}), hosted endpoint. Paid tools here return x402 payment instructions, not deliverables; pay with your own x402 client or run the local x420-mcp with your wallet key. x420_catalog and x420_quote are free.` });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: s.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const free = await callFreeTool(name, args, origin, s.catalog, fetchImpl);
        if (free) return free;
        const t = s.serviceTools.get(name);
        if (!t) return text(`unknown tool ${name}; call ${CATALOG_TOOL} to list X420's services`, true);
        const request = serviceRequest(origin, t, args);
        if ("missing" in request) return missingInputResult(t, request.missing);
        return text({
          pay_required: true,
          service: t.service.id,
          price_usd: Number(t.service.price_usd) || 0,
          currency: s.payments.currency,
          network: s.payments.network_caip2 ?? s.payments.network,
          pay_to: s.payments.pay_to,
          url: request.url,
          how: PAY_HOW,
        });
      } catch (e) {
        return text(`${name} failed: ${(e as Error).message}`, true);
      }
    });
    return server;
  };

  return async (req, res) => {
    let server: Server | null = null;
    let transport: StreamableHTTPServerTransport | null = null;
    try {
      const s = await snapshot();
      server = buildServer(s);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport?.close(); void server?.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: `x420 mcp: ${(e as Error).message}` }, id: null }));
      } else if (!res.writableEnded) res.end();
    }
  };
}
