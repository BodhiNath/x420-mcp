# x420-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for **X420**'s pay-per-call agent services at
[https://signature-theme.com](https://signature-theme.com): website audits, hail and storm history, geocoding,
DNS/TLS/RDAP lookups, government and chain data, and whatever X420 sells next. Every service becomes an MCP tool;
every paid call is settled with [x402](https://x402.org) in USDC on Base **from your own wallet**.

**X420 never sees your key.** The private key is read from your environment inside this local process, signs an
EIP-3009 USDC authorization, and only that signature leaves the machine (as the `PAYMENT-SIGNATURE` header). It is
never logged, never written to disk by this package, and never sent to X420 or anyone else.

**This spends real money.** A successful paid call moves USDC on Base mainnet. Fund a dedicated wallet with only what
you are willing to spend, keep `X420_MCP_MAX_USD` low, and rotate the key when you stop using the server.

## Install

```
npx x420-mcp
```

The server speaks MCP on stdin/stdout. On start it fetches the live catalog (`GET https://signature-theme.com/a2a/catalog`)
and registers one tool per service, named `x420_<id>` with dots replaced by underscores (`sitescan.check` →
`x420_sitescan_check`, `hail.point-history` → `x420_hail_point-history`), plus two free tools:

- `x420_catalog` — the live catalog with prices, inputs and deliverables.
- `x420_quote` — a free price quote for one service and input (no order is placed).
- `x420_spend_summary` — what this server process has paid so far (calls, total USD, last-24h USD, the caps and what
  remains under each, the verified seller pay-to address).

Nothing is hard-coded: new X420 services appear on the next start.

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "x420": {
      "command": "npx",
      "args": ["-y", "x420-mcp"],
      "env": {
        "X420_MCP_WALLET_PRIVATE_KEY": "0x<your private key>",
        "X420_MCP_MAX_USD": "1.00"
      }
    }
  }
}
```

### Claude Code

```
claude mcp add x420 -e X420_MCP_WALLET_PRIVATE_KEY=0x<your private key> -e X420_MCP_MAX_USD=1.00 -- npx -y x420-mcp
```

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "x420": {
      "command": "npx",
      "args": ["-y", "x420-mcp"],
      "env": {
        "X420_MCP_WALLET_PRIVATE_KEY": "0x<your private key>",
        "X420_MCP_MAX_USD": "1.00"
      }
    }
  }
}
```

Without a key the server still starts: the free tools work and every paid tool returns an error explaining how to set
the key. Nothing is spent until a key is present.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `X420_MCP_WALLET_PRIVATE_KEY` | unset | 0x-prefixed private key of the paying wallet (USDC on Base). Unset = paid tools refuse with instructions. Never logged, never sent. |
| `X420_MCP_MAX_USD` | `1.00` | Per-call cap in USD. A service priced above it is refused before any request; a 402 asking for more than it is refused before signing. **At the default, `sitescan.basic` ($3) and `sitescan.business` ($7) are refused** — see "Default caps" below. |
| `X420_MCP_MAX_TOTAL_USD` | `5.00` | Lifetime cap for the server process: the sum of all paid calls since it started may not exceed this. |
| `X420_MCP_MAX_DAILY_USD` | `5.00` | Rolling 24-hour cap: the sum of paid calls in the last 24 hours may not exceed this. |
| `X420_MCP_ORIGIN` | `https://signature-theme.com` | The X420 seller to talk to. |
| `X420_MCP_NETWORK` | `eip155:8453` (Base mainnet) | CAIP-2 network the payer will sign on; a 402 on any other network is refused. |

## Default caps

Out of the box the server pays at most **$1.00 per call**, **$5.00 per rolling 24 hours** and **$5.00 over the life of
the process**. Two X420 services cost more than $1.00 and are therefore **refused at the default**:

| Service | Price | At the default cap |
| --- | --- | --- |
| `sitescan.basic` | $3.00 | refused ("above the per-call cap X420_MCP_MAX_USD=$1.00") |
| `sitescan.business` | $7.00 | refused ("above the per-call cap X420_MCP_MAX_USD=$1.00") |

To allow them, raise the per-call cap in the server's `env` (and the daily/lifetime caps if several calls are planned):

```json
"env": {
  "X420_MCP_WALLET_PRIVATE_KEY": "0x<your private key>",
  "X420_MCP_MAX_USD": "7",
  "X420_MCP_MAX_DAILY_USD": "25",
  "X420_MCP_MAX_TOTAL_USD": "25"
}
```

Every refusal names the cap that blocked it, for example
`refused by X420_MCP_MAX_DAILY_USD=$5.00: paying $0.50 for sitescan.check would bring rolling 24h spend to $5.25 (spent $4.75 across 9 paid calls so far).`
`x420_spend_summary` shows the running totals at any time.

## What the server will and will not sign

Before signing anything the payer checks the seller's 402 against fixed rules; any mismatch refuses and nothing is signed:

- scheme `exact` on the configured network only (`X420_MCP_NETWORK`, default `eip155:8453`);
- the asset must be that network's canonical USDC contract, compared as an address
  (Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — a
  token that merely calls itself "USD Coin" is refused;
- `payTo` must equal the address the seller advertises in its Agent Card (`/.well-known/agent.json`, `payments.pay_to`),
  fetched when the server starts; if the card cannot be read, paid tools refuse rather than pay an unverified recipient;
- the amount must be within `X420_MCP_MAX_USD`, and must keep the process under `X420_MCP_MAX_TOTAL_USD` and
  `X420_MCP_MAX_DAILY_USD`.

## How a paid call works

1. The tool call becomes `GET <origin>/a2a/x402/<service id>?<params>`.
2. X420 answers `402` with an x402 v2 `PAYMENT-REQUIRED` header (exact scheme, USDC on Base, amount, pay-to).
3. The server checks scheme, network, asset and amount against your cap, signs the authorization with your key
   (`@x402/fetch` + `@x402/evm`), and retries with `PAYMENT-SIGNATURE`.
4. X420's facilitator settles on Base and X420 returns the deliverable with a signed receipt; the tool result carries
   the deliverable, the receipt, the order and the settlement transaction hash from `PAYMENT-RESPONSE`.

```json
{
  "service": "sitescan.check",
  "price_usd": 0.5,
  "paid_usd": 0.5,
  "deliverable": { "target": "https://example.com", "summary": { "score": 82, "grade": "B", "findings": 3 }, "findings": [] },
  "receipt": { "receipt_id": "...", "deliverable_sha256": "...", "payee": "x420:...", "sig": "<ed25519 hex>" },
  "order": { "id": "...", "status": "delivered", "amount_usd": 0.5, "rail": "x402" },
  "settlement": { "transaction": "0x...", "network": "eip155:8453", "payer": "0x...", "success": true, "error": null }
}
```

A refused call (no key, over the cap, wrong network, non-USDC asset, missing input) returns an MCP error result with
the reason, and nothing is signed.

## No key? Use the hosted endpoint

X420 also serves the same tools over MCP Streamable HTTP at **https://signature-theme.com/mcp**. That endpoint holds
no wallet: `x420_catalog` and `x420_quote` work as above, and each paid tool validates your input and returns
**payment instructions** (price, pay-to address, network and the x402 URL) instead of the deliverable, so an agent with
its own x402 client can pay directly.

```
claude mcp add --transport http x420 https://signature-theme.com/mcp
```

## Programmatic use

```ts
import { createX420McpServer } from "x420-mcp";
const { server, tools } = await createX420McpServer({ origin: "https://signature-theme.com", maxUsd: 1, privateKey: process.env.X420_MCP_WALLET_PRIVATE_KEY ?? null });
```

`x420-mcp/hosted` exports `createHostedMcpHandler({ origin })`, the express-compatible stateless Streamable HTTP
handler behind the hosted endpoint.

## Disclaimer

Automated services on public data; not professional, legal, insurance, engineering, medical, financial or tax advice.

MIT License. Source: https://github.com/BodhiNath/x420-mcp (`packages/x420-mcp`, built from `src/mcp`).
