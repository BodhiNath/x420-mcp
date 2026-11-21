/**
 * X420 MCP server (local, paying): X420's paid services as Model Context Protocol tools, paid per call with x402 from
 * the user's own wallet. The catalog and the seller's Agent Card are read live at start (one tool per service, see
 * catalog.ts; the card's pay_to is the only recipient the payer will sign for). Free tools expose the catalog, quotes
 * and this process's own spending. Every paid call is gated before any request: the catalog price against
 * X420_MCP_MAX_USD, then the lifetime and rolling-24h caps (ledger.ts); the payer's selector re-checks the 402's own
 * network, asset, recipient and amount before signing (pay.ts). Stdio transport: nothing but protocol goes to stdout;
 * status lines go to stderr; the key goes nowhere. The hosted, non-paying variant for public directories is hosted.ts.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { fetchAgentCardPayments, fetchCatalog, serviceTool, trimOrigin, type Catalog, type ServiceTool, fmtUsd } from "./catalog.js";
import { DEFAULT_MAX_DAILY_USD, DEFAULT_MAX_TOTAL_USD, MAX_DAILY_ENV, MAX_TOTAL_ENV, SpendLedger, capRefusalMessage } from "./ledger.js";
import { DEFAULT_MAX_USD, DEFAULT_NETWORK, DEFAULT_ORIGIN, KEY_ENV, MAX_ENV, NETWORK_ENV, ORIGIN_ENV, createX402Payer, isPrivateKey, missingKeyMessage, readBody, unverifiedPayToMessage, type PayFn } from "./pay.js";
import { CATALOG_TOOL, QUOTE_TOOL, callFreeTool, freeTools, missingInputResult, serviceRequest, text } from "./tools.js";

export { CATALOG_TOOL, QUOTE_TOOL };
export const SPEND_TOOL = "x420_spend_summary";
export const SERVER_NAME = "x420-mcp";
export const SERVER_VERSION = "1.0.2";

export interface X420McpOptions {
  origin?: string;
  maxUsd?: number;
  /** Lifetime cap for this process (X420_MCP_MAX_TOTAL_USD). */
  maxTotalUsd?: number;
  /** Rolling 24h cap (X420_MCP_MAX_DAILY_USD). */
  maxDailyUsd?: number;
  /** The buyer key; read from X420_MCP_WALLET_PRIVATE_KEY by `optionsFromEnv`. Null = paid tools explain how to set it. */
  privateKey?: string | null;
  /** CAIP-2 network the payer will sign on (default Base mainnet). */
  network?: string;
  /** The seller's pay-to address. Undefined = read it from the Agent Card at start; null = unverified (paid calls refuse). */
  payTo?: string | null;
  /** Injected payment step; when given, `privateKey`/`payTo` are not used. Tests pass a stand-in that never touches a chain. */
  payer?: PayFn | null;
  /** Injected ledger (tests); default a fresh one with the caps above. */
  ledger?: SpendLedger;
  /** Clock for the ledger (tests). */
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Where status lines go (default stderr). Never the key. */
  log?: (line: string) => void;
}

export interface X420McpServer {
  server: Server;
  catalog: Catalog;
  tools: Tool[];
  serviceTools: Map<string, ServiceTool>;
  origin: string;
  maxUsd: number;
  ledger: SpendLedger;
  /** The verified seller recipient, or null with the reason it could not be verified. */
  payTo: string | null;
  payToError: string | null;
}

const money = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number of US dollars (got ${JSON.stringify(raw)})`);
  return n;
};

/** Read the server's settings from the environment. The key value is returned, never printed. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): X420McpOptions {
  const key = env[KEY_ENV];
  if (key && !isPrivateKey(key)) throw new Error(`${KEY_ENV} is set but is not a 0x-prefixed 64-hex-character private key`);
  return {
    origin: env[ORIGIN_ENV] || DEFAULT_ORIGIN,
    maxUsd: money(env, MAX_ENV, DEFAULT_MAX_USD),
    maxTotalUsd: money(env, MAX_TOTAL_ENV, DEFAULT_MAX_TOTAL_USD),
    maxDailyUsd: money(env, MAX_DAILY_ENV, DEFAULT_MAX_DAILY_USD),
    privateKey: key || null,
    network: env[NETWORK_ENV] || DEFAULT_NETWORK,
  };
}

export async function createX420McpServer(opts: X420McpOptions = {}): Promise<X420McpServer> {
  const origin = trimOrigin(opts.origin ?? DEFAULT_ORIGIN);
  const maxUsd = opts.maxUsd ?? DEFAULT_MAX_USD;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ledger = opts.ledger ?? new SpendLedger({ maxTotalUsd: opts.maxTotalUsd ?? DEFAULT_MAX_TOTAL_USD, maxDailyUsd: opts.maxDailyUsd ?? DEFAULT_MAX_DAILY_USD }, opts.now ?? Date.now);

  const catalog = await fetchCatalog(origin, fetchImpl);
  const serviceTools = new Map<string, ServiceTool>();
  for (const s of catalog.services) { const t = serviceTool(s); serviceTools.set(t.name, t); }

  // The only recipient the payer will ever sign for: the address the seller advertises in its Agent Card.
  let payTo: string | null = null, payToError: string | null = null;
  if (opts.payTo !== undefined) { payTo = opts.payTo; if (!payTo) payToError = "no pay_to configured"; }
  else {
    try { payTo = (await fetchAgentCardPayments(origin, fetchImpl)).pay_to; if (!payTo) payToError = "card carries no payments.pay_to"; }
    catch (e) { payToError = (e as Error).message; }
  }
  const hasKey = Boolean(opts.payer) || Boolean(opts.privateKey);
  const payer: PayFn | null = opts.payer ?? (opts.privateKey && payTo ? createX402Payer(opts.privateKey, { network: opts.network, fetchImpl, payTo, ledger }) : null);

  const tools: Tool[] = [
    ...freeTools(origin, catalog),
    {
      name: SPEND_TOOL,
      description: `Free. This server's own spending so far: paid calls, total USD, last-24h USD, the caps (${MAX_ENV} per call, ${MAX_TOTAL_ENV} lifetime, ${MAX_DAILY_ENV} rolling 24h) and what remains under each, plus whether a wallet is configured and the verified seller pay-to address.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ...[...serviceTools.values()].map((t): Tool => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: t.service.name, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    })),
  ];

  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: `X420 agent services (${catalog.agent || origin}). Paid tools spend real USDC on Base via x402 from the user's wallet; caps: $${maxUsd.toFixed(2)} per call (${MAX_ENV}), $${ledger.caps.maxTotalUsd.toFixed(2)} lifetime (${MAX_TOTAL_ENV}), $${ledger.caps.maxDailyUsd.toFixed(2)} per rolling 24h (${MAX_DAILY_ENV}). Check x420_catalog for prices and x420_spend_summary for what has been spent.` });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const free = await callFreeTool(name, args, origin, catalog, fetchImpl);
      if (free) return free;
      if (name === SPEND_TOOL) return text({ ...ledger.summary(maxUsd), wallet: payer ? "configured" : "not configured", seller_pay_to: payTo, pay_to_error: payToError });
      const t = serviceTools.get(name);
      if (!t) return text(`unknown tool ${name}; call ${CATALOG_TOOL} to list X420's services`, true);
      return await callService(t, args);
    } catch (e) {
      return text(`${name} failed: ${(e as Error).message}`, true);
    }
  });

  async function callService(t: ServiceTool, args: Record<string, unknown>): Promise<CallToolResult> {
    const s = t.service;
    const price = Number(s.price_usd) || 0;
    if (price > maxUsd) return text(`refused: ${s.id} costs ${fmtUsd(price)} USDC per call, above the per-call cap ${MAX_ENV}=$${maxUsd.toFixed(2)}. Set ${MAX_ENV}=${Math.ceil(price)} (or higher) in the MCP server's environment and restart it only if you mean to spend that much per call.`, true);
    const request = serviceRequest(origin, t, args);
    if ("missing" in request) return missingInputResult(t, request.missing);
    const { url } = request;

    if (price > 0) {
      if (!hasKey) return text(missingKeyMessage(), true);
      if (!payer) return text(unverifiedPayToMessage(origin, payToError ?? "unknown"), true);
      const blocked = ledger.check(price);
      if (blocked) return text(capRefusalMessage(blocked, price, s.id, ledger.count()), true);
    }
    const result = payer && price > 0
      ? await payer(url, maxUsd)
      : await (async () => { const r = await fetchImpl(url, { headers: { accept: "application/json" } }); return { status: r.status, body: await readBody(r), settlement: null, paid_usd: 0 }; })();
    if (result.paid_usd > 0) ledger.record({ service: s.id, amount_usd: result.paid_usd, transaction: result.settlement?.transaction ?? null });

    const body = (result.body && typeof result.body === "object" ? result.body : { raw: result.body }) as Record<string, unknown>;
    if (result.status !== 200) {
      log(`${s.id} -> HTTP ${result.status}`);
      return text({ error: `${s.id} answered HTTP ${result.status}`, ...(result.status === 402 ? { hint: "the payment was not accepted; nothing was delivered" } : {}), response: body, settlement: result.settlement }, true);
    }
    log(`${s.id} -> delivered${result.settlement?.transaction ? ` tx ${result.settlement.transaction}` : ""}${result.paid_usd ? ` ($${result.paid_usd} USDC; lifetime $${ledger.totalUsd()})` : ""}`);
    return text({
      service: s.id,
      price_usd: price,
      paid_usd: result.paid_usd,
      deliverable: body.deliverable ?? body,
      receipt: body.receipt ?? null,
      order: body.order ?? null,
      settlement: result.settlement ? { transaction: result.settlement.transaction, network: result.settlement.network, payer: result.settlement.payer, success: result.settlement.success, error: result.settlement.error } : null,
      spend: { total_usd: ledger.totalUsd(), last_24h_usd: ledger.dailyUsd(), calls: ledger.count() },
    });
  }

  const walletState = payer ? "configured" : hasKey ? `key set but seller pay_to unverified (${payToError})` : `not configured (set ${KEY_ENV} to enable paid tools)`;
  log(`${SERVER_NAME}: ${serviceTools.size} service tool(s) from ${origin}; caps $${maxUsd.toFixed(2)}/call, $${ledger.caps.maxTotalUsd.toFixed(2)} lifetime, $${ledger.caps.maxDailyUsd.toFixed(2)}/24h; seller pay_to ${payTo ?? "UNVERIFIED"}; wallet ${walletState}`);
  return { server, catalog, tools, serviceTools, origin, maxUsd, ledger, payTo, payToError };
}

/** Entry point for the CLI: settings from the environment, catalog from the origin, then serve on stdio. */
export async function startStdio(env: NodeJS.ProcessEnv = process.env): Promise<X420McpServer> {
  const s = await createX420McpServer(optionsFromEnv(env));
  await s.server.connect(new StdioServerTransport());
  return s;
}
