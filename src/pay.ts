/**
 * The paid step of a tool call: a GET that the seller answers with 402 (x402 v2 PAYMENT-REQUIRED) and, once a signed
 * USDC authorization is attached as PAYMENT-SIGNATURE, with 200 and a PAYMENT-RESPONSE settlement header. The step is
 * a function value (`PayFn`) so tests inject a stand-in and never touch a chain; the real one wraps fetch with the
 * official `@x402/fetch` client and the `@x402/evm` exact scheme, signing with the key from the environment.
 *
 * What the real payer will sign, and nothing else: an `exact` requirement on the configured CAIP-2 network, whose
 * `asset` is that network's canonical USDC contract (address comparison, no name matching), whose `payTo` is the
 * address the seller advertises in its Agent Card, whose amount is within the per-call cap, and which keeps the
 * process under its lifetime and rolling-24h caps. Any mismatch refuses before signing.
 *
 * The private key is read from X420_MCP_WALLET_PRIVATE_KEY only, lives in this process only, is never logged and is
 * never sent anywhere: the seller sees a signed EIP-3009 authorization, not the key.
 */
import { capRefusalMessage, type SpendLedger } from "./ledger.js";

export { DEFAULT_MAX_DAILY_USD, DEFAULT_MAX_TOTAL_USD, MAX_DAILY_ENV, MAX_TOTAL_ENV } from "./ledger.js";
export const KEY_ENV = "X420_MCP_WALLET_PRIVATE_KEY";
export const MAX_ENV = "X420_MCP_MAX_USD";
export const ORIGIN_ENV = "X420_MCP_ORIGIN";
export const NETWORK_ENV = "X420_MCP_NETWORK";
export const DEFAULT_ORIGIN = "https://signature-theme.com";
export const DEFAULT_MAX_USD = 1;
/** Base mainnet, where X420 sells. A 402 asking for any other network is refused before signing. */
export const DEFAULT_NETWORK = "eip155:8453";
export const USDC_DECIMALS = 6;
/** Canonical USDC contracts per CAIP-2 network. A requirement naming any other asset is refused, whatever it calls itself. */
export const USDC_BY_NETWORK: Record<string, `0x${string}`> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};
export const usdcFor = (network: string): `0x${string}` | null => USDC_BY_NETWORK[network] ?? null;
export const isAddress = (a: unknown): a is `0x${string}` => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const sameAddress = (a: unknown, b: unknown): boolean => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();

export interface Settlement { success: boolean; transaction: string | null; network: string | null; payer: string | null; error: string | null }
export interface PaidResponse { status: number; body: unknown; settlement: Settlement | null; paid_usd: number }
/** Performs the (possibly paid) GET of `url`, paying at most `maxUsd`; resolves with the final response. */
export type PayFn = (url: string, maxUsd: number) => Promise<PaidResponse>;

export const isPrivateKey = (k: unknown): k is `0x${string}` => typeof k === "string" && /^0x[0-9a-fA-F]{64}$/.test(k);

export function missingKeyMessage(): string {
  return `${KEY_ENV} is not set, so this paid tool cannot run. Set it in the MCP server's environment to the 0x-prefixed private key of a wallet holding USDC on Base (eip155:8453), then restart the server. Every paid call spends real USDC from that wallet; ${MAX_ENV} (default $${DEFAULT_MAX_USD.toFixed(2)}) caps each call. X420 never receives the key: it stays in this local process and only signs payment authorizations.`;
}

export function unverifiedPayToMessage(origin: string, reason: string): string {
  return `refused: the seller's pay-to address could not be verified (agent card ${origin}/.well-known/agent.json: ${reason}). This server pays only the address the seller advertises there, so no payment was signed; restart the server once the card is reachable.`;
}

/** Decode a response body as JSON when it is JSON, else keep the text. */
export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

const serviceFromUrl = (url: string): string => { const m = /\/a2a\/x402\/([^/?#]+)/.exec(url); return m ? decodeURIComponent(m[1]) : url; };

export interface PayerOptions {
  /** CAIP-2 network to sign on; must have a known USDC contract. */
  network?: string;
  fetchImpl?: typeof fetch;
  /** The seller's advertised pay-to address (Agent Card `payments.pay_to`); a 402 naming any other recipient is refused. */
  payTo: string;
  /** Cumulative caps; checked against the 402's amount before signing. */
  ledger?: SpendLedger;
}

/**
 * The real payer. Policy sits in the requirement selector; the SDK's own default spend control ($1 per payment) is
 * replaced by the per-call cap so the user's X420_MCP_MAX_USD is the single per-call number that matters.
 */
export function createX402Payer(privateKey: string, opts: PayerOptions): PayFn {
  if (!isPrivateKey(privateKey)) throw new Error(`${KEY_ENV} must be a 0x-prefixed 64-hex-character private key`);
  const network = opts.network ?? DEFAULT_NETWORK;
  const usdc = usdcFor(network);
  if (!usdc) throw new Error(`${NETWORK_ENV}=${network} has no known USDC contract; supported: ${Object.keys(USDC_BY_NETWORK).join(", ")}`);
  if (!isAddress(opts.payTo)) throw new Error(`seller pay_to ${String(opts.payTo)} is not an EVM address`);
  const payTo = opts.payTo;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (url, maxUsd) => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } = await import("@x402/fetch");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    type Requirements = import("@x402/core/types").PaymentRequirements;

    let chosen: Requirements | null = null;
    const select = (_version: number, reqs: Requirements[]): Requirements => {
      if (!reqs.length) throw new Error("402 carries no payment requirements");
      const exact = reqs.filter((r) => r.scheme === "exact");
      if (!exact.length) throw new Error("402 offers no exact-scheme requirement");
      const onNetwork = exact.filter((r) => r.network === network);
      if (!onNetwork.length) throw new Error(`402 wants payment on ${[...new Set(exact.map((r) => r.network))].join("/")}; this server pays on ${network} only (${NETWORK_ENV})`);
      const onAsset = onNetwork.filter((r) => sameAddress(r.asset, usdc));
      if (!onAsset.length) throw new Error(`402 asks for asset ${[...new Set(onNetwork.map((r) => r.asset))].join("/")}; this server pays only USDC ${usdc} on ${network}`);
      const r = onAsset.find((x) => sameAddress(x.payTo, payTo));
      if (!r) throw new Error(`402 names payTo ${[...new Set(onAsset.map((x) => x.payTo))].join("/")}, but the seller's agent card advertises ${payTo}; refusing to pay an unverified recipient`);
      const amount = Number(r.amount) / 10 ** USDC_DECIMALS;
      if (!(amount <= maxUsd)) throw new Error(`402 asks for $${amount} USDC, above the per-call cap ${MAX_ENV}=$${maxUsd}`);
      const blocked = opts.ledger?.check(amount);
      if (blocked) throw new Error(capRefusalMessage(blocked, amount, serviceFromUrl(url), opts.ledger!.count()));
      chosen = r;
      return r;
    };
    const account = privateKeyToAccount(privateKey);
    const client = new x402Client(select);
    registerExactEvmScheme(client, { signer: account, paymentRequirementsSelector: select });
    client.setSpendControls(false);
    const fetchWithPay = wrapFetchWithPayment(fetchImpl, client);
    let res: Response;
    try { res = await fetchWithPay(url, { headers: { accept: "application/json" } }); }
    catch (e) { throw new Error(String((e as Error).message).replace(/^Failed to create payment payload: /, "")); }
    const body = await readBody(res);
    let settlement: Settlement | null = null;
    const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    if (header) {
      try {
        const s = decodePaymentResponseHeader(header);
        settlement = { success: Boolean(s.success), transaction: s.transaction || null, network: s.network ?? null, payer: s.payer ?? account.address, error: s.errorReason ? `${s.errorReason}${s.errorMessage ? `: ${s.errorMessage}` : ""}` : null };
      } catch (e) { settlement = { success: false, transaction: null, network: null, payer: account.address, error: `settlement header unreadable: ${(e as Error).message}` }; }
    }
    const paid = chosen ? Number((chosen as Requirements).amount) / 10 ** USDC_DECIMALS : 0;
    return { status: res.status, body, settlement, paid_usd: res.ok && settlement?.success ? paid : 0 };
  };
}
