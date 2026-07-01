/**
 * Agent Buyer Gate — proof-of-funds firewall for agent traffic (PoC).
 *
 * Forget agent identity. Gate on economics: an agent with a funded, active wallet
 * is a qualified buyer; everything else is scrape traffic we should not feed fresh
 * data for free. This worker sits in front of the data/API surface and, before the
 * origin is ever touched, reads the agent's on-chain USDC balance + activity on
 * Base and either welcomes it (serve + free credits, pay-per-call via x402) or
 * returns a 402 funding challenge. Public/SEO pages pass through untouched.
 *
 * Wallet control is PROVEN over a fresh, path-bound challenge, verified universally:
 * an EOA by ecrecover, a smart-contract wallet (Coinbase Smart Wallet / ERC-4337) by
 * EIP-1271, an undeployed account by ERC-6492 (all via viem `verifyMessage`), so the
 * address cannot be spoofed. Existing API-key (Bearer) traffic passes straight through
 * and is never gated. Intent scoring (tx-graph allowlist + optional AI classifier) runs
 * today in score-only mode (INTENT_MIN=0). The 402 is spec-compliant x402 (top-level
 * `accepts`) plus an `agent_gate` qualification extension, so it composes with any x402
 * client. See ../README.md and .claude/plans/agent-buyer-gate.md.
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

export interface Env {
  BASE_RPC_URL?: string;   // balance/nonce reads (default https://mainnet.base.org)
  INTENT_RPC_URL?: string; // transfer-graph eth_getLogs (needs a getLogs-capable RPC; falls back to BASE_RPC_URL)
  USDC_ADDRESS?: string;   // default Base mainnet USDC
  MIN_USDC?: string;       // dollars, default "100"
  MIN_NONCE?: string;      // activity floor (tx count), default "3"
  GATED_PREFIX?: string;   // path prefix to gate, default "/api/v1/"
  ORIGIN_URL?: string;     // forward qualified requests here (standalone PoC)
  KNOWN_PAYEES?: string;   // comma-sep allowlist of AI/agent-commerce payee addresses (intent)
  INTENT_MIN?: string;     // min intent score to qualify; "0" = score only, don't gate (default)
  CLASSIFIER_URL?: string; // optional AI-classifier endpoint for borderline wallets
  CLASSIFIER_KEY?: string; // bearer for the classifier
  AGENT_GATE_KV?: KVNamespace; // optional per-wallet verdict cache
  X402_PAY_TO?: string;    // seller wallet that receives x402 pay-per-call settlement (enables the standard `accepts` block)
  X402_PRICE?: string;     // dollars per call advertised in the x402 `accepts` block, default "0.01"
  X402_NETWORK?: string;   // x402 network id, default "base"
}

const USDC_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base mainnet USDC (6 decimals)
const RPC_DEFAULT = 'https://mainnet.base.org';
const PROOF_TTL_SEC = 300; // how long a signed wallet proof stays valid (replay window)

interface Verdict {
  wallet: string;
  wallet_type: 'eoa' | 'smart'; // smart = deployed contract wallet (Coinbase Smart Wallet / ERC-4337)
  usdc_balance: number;
  tx_count: number;
  funded: boolean;
  active: boolean;
  // Intent: is this wallet actually SPENDING on AI/data tools (aligned buyer) vs
  // just parking money? Refines a funded+active wallet from "can pay" to "wants
  // what we sell." Score 0-100; signals explain it.
  intent_score: number;
  intent_signals: string[];
  aligned_payees: string[];   // recent USDC counterparties on the KNOWN_PAYEES allowlist
  usdc_out_count: number;     // recent outbound USDC transfers (is it a spender?)
  qualified: boolean;
  tier: 'rejected' | 'standard' | 'priority';
  free_credits: number;       // grant scales with intent (priority buyers get more)
  reason: string;
  cached?: boolean;
}

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result || '0x0';
}

async function usdcBalance(env: Env, wallet: string): Promise<bigint> {
  // balanceOf(address) selector 0x70a08231 + 32-byte left-padded address
  const data = '0x70a08231' + wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const res = await rpc(env.BASE_RPC_URL || RPC_DEFAULT, 'eth_call', [{ to: env.USDC_ADDRESS || USDC_DEFAULT, data }, 'latest']);
  return BigInt(res); // 6 decimals
}

async function txCount(env: Env, wallet: string): Promise<number> {
  const res = await rpc(env.BASE_RPC_URL || RPC_DEFAULT, 'eth_getTransactionCount', [wallet, 'latest']);
  return Number(BigInt(res));
}

/** Is this address a deployed smart-contract wallet (has bytecode) vs a plain EOA?
 *  Matters because a smart account's EOA nonce is ~0 (txns route through a bundler),
 *  so the EOA activity floor would wrongly reject it. A deployed contract wallet that
 *  clears the funding bar is itself an anti-freshly-minted signal. */
async function isContractWallet(env: Env, wallet: string): Promise<boolean> {
  const code = await rpc(env.BASE_RPC_URL || RPC_DEFAULT, 'eth_getCode', [wallet, 'latest']);
  return !!code && code !== '0x' && code !== '0x0';
}

/** A viem public client over the Base RPC. Used for universal signature verification
 *  (EOA ecrecover AND EIP-1271 `isValidSignature` for smart-contract wallets, plus
 *  ERC-6492 for not-yet-deployed accounts) in one call. */
function publicClient(env: Env) {
  return createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL || RPC_DEFAULT) });
}

async function rpcAny(url: string, method: string, params: unknown[]): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: any; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

interface Intent { score: number; signals: string[]; aligned: string[]; out_count: number }

/** Score "aligned intent" from the wallet's recent USDC transfer graph: does it
 *  pay known AI/agent-commerce payees, and is it an active spender (not a parked
 *  sybil)? Best-effort: never blocks a funded+active wallet if the log scan fails
 *  (intent refines the verdict, it is not the economic gate). */
async function scoreIntent(env: Env, wallet: string): Promise<Intent> {
  const known = new Set((env.KNOWN_PAYEES || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const rpcUrl = env.INTENT_RPC_URL || env.BASE_RPC_URL || RPC_DEFAULT;
  const usdc = env.USDC_ADDRESS || USDC_DEFAULT;
  const signals: string[] = [];
  try {
    // Alchemy enhanced API: the wallet's recent OUTBOUND USDC transfers (who it
    // pays). Standard eth_getLogs is range-limited on free tiers (Alchemy = 10
    // blocks), so this purpose-built wallet-history call is what makes the intent
    // scan work on the free tier. Needs an Alchemy-style RPC as INTENT/BASE_RPC_URL.
    const res = await rpcAny(rpcUrl, 'alchemy_getAssetTransfers', [{
      fromAddress: wallet, contractAddresses: [usdc], category: ['erc20'],
      maxCount: '0x32', order: 'desc', excludeZeroValue: true,
    }]);
    const recipients = ((res?.transfers || []) as { to?: string }[])
      .map((t) => (t.to || '').toLowerCase()).filter(Boolean);
    const aligned = [...new Set(recipients)].filter((a) => known.has(a));
    let score = 0;
    if (aligned.length) { score += 50 + Math.min(30, (aligned.length - 1) * 10); signals.push('aligned_payee'); }
    if (recipients.length >= 3) { score += 20; signals.push('active_spender'); }
    else if (recipients.length >= 1) { score += 10; signals.push('has_spent'); }

    // Optional AI classifier: the "authentic + interesting tools" read on borderline wallets.
    if (env.CLASSIFIER_URL) {
      try {
        const cr = await fetch(env.CLASSIFIER_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(env.CLASSIFIER_KEY ? { authorization: `Bearer ${env.CLASSIFIER_KEY}` } : {}) },
          body: JSON.stringify({ wallet, recipients: [...new Set(recipients)], out_count: recipients.length }),
        });
        const cj = (await cr.json()) as { intent_score?: number; label?: string };
        if (typeof cj.intent_score === 'number') { score = Math.max(score, cj.intent_score); signals.push(`ai:${cj.label || 'scored'}`); }
      } catch { signals.push('ai_classifier_error'); }
    }
    return { score: Math.min(100, score), signals, aligned, out_count: recipients.length };
  } catch {
    return { score: 0, signals: ['intent_scan_unavailable'], aligned: [], out_count: 0 };
  }
}

async function qualify(env: Env, wallet: string): Promise<Verdict> {
  const key = `verdict:${wallet.toLowerCase()}`;
  if (env.AGENT_GATE_KV) {
    const cached = await env.AGENT_GATE_KV.get(key, 'json');
    if (cached) return { ...(cached as Verdict), cached: true };
  }

  const minUsdc = BigInt(Math.round(Number(env.MIN_USDC || '100') * 1e6));
  const minNonce = Number(env.MIN_NONCE || '3');
  const intentMin = Number(env.INTENT_MIN || '0'); // 0 = score-only (the x402 ecosystem is young; don't hard-gate on it yet)
  const [bal, nonce, isSmart, intent] = await Promise.all([
    usdcBalance(env, wallet), txCount(env, wallet), isContractWallet(env, wallet), scoreIntent(env, wallet),
  ]);
  const usd = Number(bal) / 1e6;
  const funded = bal >= minUsdc;
  // Activity floor is anti "freshly-minted EOA bypass". For a smart-contract wallet
  // the EOA nonce is meaningless (~0), so being a DEPLOYED contract account that also
  // clears the funding bar is the equivalent signal; EOAs still need real tx history.
  const wallet_type: Verdict['wallet_type'] = isSmart ? 'smart' : 'eoa';
  const active = isSmart ? true : nonce >= minNonce;
  const intentOk = intent.score >= intentMin;
  const qualified = funded && active && intentOk;
  const tier: Verdict['tier'] = !qualified ? 'rejected' : intent.score >= 50 ? 'priority' : 'standard';
  const free_credits = tier === 'priority' ? 100 : tier === 'standard' ? 25 : 0;

  const reason = qualified
    ? (tier === 'priority' ? 'funded, active, aligned-spend intent (priority buyer)' : `funded + active ${wallet_type} wallet (qualified buyer)`)
    : !funded ? `needs >= $${env.MIN_USDC || '100'} USDC on Base (has $${usd.toFixed(2)})`
      : !active ? `EOA looks freshly minted (tx count ${nonce} < ${minNonce})`
        : `intent score ${intent.score} below minimum ${intentMin}`;

  const verdict: Verdict = {
    wallet, wallet_type, usdc_balance: usd, tx_count: nonce, funded, active,
    intent_score: intent.score, intent_signals: intent.signals, aligned_payees: intent.aligned, usdc_out_count: intent.out_count,
    qualified, tier, free_credits, reason,
  };
  if (env.AGENT_GATE_KV) await env.AGENT_GATE_KV.put(key, JSON.stringify(verdict), { expirationTtl: 300 });
  return verdict;
}

/** The exact message an agent must EIP-191 sign to prove wallet control. Bound to
 *  the wallet + request path + issued timestamp so a captured proof cannot be
 *  replayed against another path or outside the freshness window. */
function gateMessage(wallet: string, pathname: string, issued: string): string {
  return `StartupHub Agent Gate\nWallet: ${wallet}\nPath: ${pathname}\nIssued: ${issued}`;
}

/** Prove the caller controls the claimed wallet. Verification is UNIVERSAL: an EOA is
 *  checked by ecrecover, a smart-contract wallet by EIP-1271 `isValidSignature` (and
 *  ERC-6492 for a not-yet-deployed account), all via `verifyMessage`. The signature is
 *  never trusted as an address header; it must validate against the claimed wallet for
 *  the exact path-and-time-bound message. Returns the lowercased address, else null. */
async function verifyWalletProof(env: Env, req: Request, pathname: string): Promise<string | null> {
  const wallet = req.headers.get('x-agent-wallet') || '';
  const sig = req.headers.get('x-agent-signature') || '';
  const issued = req.headers.get('x-agent-issued') || '';
  // Signature is variable-length: a 65-byte EOA sig OR a longer EIP-1271 payload
  // (passkey/WebAuthn, multisig bundle), so only require well-formed hex, not a fixed size.
  if (!isAddr(wallet) || !/^0x[0-9a-fA-F]{2,}$/.test(sig) || !/^\d+$/.test(issued)) return null;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(issued)) > PROOF_TTL_SEC) return null;
  try {
    const ok = await publicClient(env).verifyMessage({
      address: wallet as `0x${string}`,
      message: gateMessage(wallet, pathname, issued),
      signature: sig as `0x${string}`,
    });
    return ok ? wallet.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The standard x402 `accepts` block: the pay-per-call option a plain x402 client (or
 *  Cloudflare's Monetization Gateway) understands without knowing anything about our
 *  qualification layer. Priced in USDC atomic units. Returns [] if no seller wallet is
 *  configured (X402_PAY_TO), which just means "no direct-pay option, prove a wallet". */
function x402Accepts(env: Env, resource: string): Record<string, unknown>[] {
  const payTo = env.X402_PAY_TO;
  if (!payTo) return [];
  const maxAmountRequired = String(Math.round(Number(env.X402_PRICE || '0.01') * 1e6)); // USDC 6 decimals
  return [{
    scheme: 'exact',
    network: env.X402_NETWORK || 'base',
    maxAmountRequired,
    resource,
    description: 'StartupHub API call (pay-per-request via x402)',
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 60,
    asset: env.USDC_ADDRESS || USDC_DEFAULT,
    extra: { name: 'USD Coin', version: '2' },
  }];
}

/** A `402 Payment Required` that is BOTH: (1) spec-compliant x402 (top-level
 *  `x402Version` + `accepts`), so any x402 client / the Monetization Gateway can pay
 *  per call, and (2) our qualification extension (`agent_gate`), the funded-wallet
 *  proof path that yields a free sample + tier instead of paying. Compose, don't
 *  reinvent: the `accepts` block is the rail, `agent_gate` is our underwriting layer. */
function challenge(env: Env, resource: string, extra?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify(
      {
        x402Version: 1,
        accepts: x402Accepts(env, resource),
        error: 'agent_buyer_gate',
        agent_gate: {
          message: 'Open to qualified agent buyers. Prove a funded wallet for a free sample + tier, or pay per call via the x402 `accepts` options above.',
          requirements: {
            network: 'base',
            asset: 'USDC',
            min_balance_usd: Number(env.MIN_USDC || '100'),
          },
          prove_wallet: {
            scheme: 'EIP-191 personal_sign (EOA) or EIP-1271 signature (smart-contract wallet) with your funded wallet',
            message_template: 'StartupHub Agent Gate\\nWallet: <your-address>\\nPath: <request-path>\\nIssued: <unix-seconds>',
            send_headers: ['X-Agent-Wallet: 0x...', 'X-Agent-Signature: 0x... (65-byte EOA sig or longer EIP-1271 payload)', 'X-Agent-Issued: <unix-seconds>'],
            freshness_seconds: PROOF_TTL_SEC,
          },
          on_qualify: 'you receive the API menu + free trial credits and can pay per call via x402',
        },
        ...extra,
      },
      null,
      2,
    ),
    { status: 402, headers: { 'content-type': 'application/json', 'x-agent-gate': 'challenge' } },
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const gatedPrefix = env.GATED_PREFIX || '/api/v1/';
    const origin = (p: string) => (env.ORIGIN_URL ? env.ORIGIN_URL + p : req.url);

    // Diagnostic: curl the verdict for any wallet without needing an origin.
    if (url.pathname === '/__agent-gate/check') {
      const wallet = req.headers.get('x-agent-wallet') || url.searchParams.get('wallet') || '';
      if (!isAddr(wallet)) return challenge(env, req.url, { hint: 'pass ?wallet=0x... or the X-Agent-Wallet header' });
      try {
        return Response.json(await qualify(env, wallet));
      } catch (e) {
        return Response.json({ error: 'rpc_error', detail: String(e) }, { status: 502 });
      }
    }

    // Public/SEO surface passes through untouched.
    if (!url.pathname.startsWith(gatedPrefix)) {
      return fetch(new Request(origin(url.pathname + url.search), req));
    }

    // Existing customers (API key) pass straight through — never gate paid Bearer
    // traffic. The gate is only for anonymous agents with no account.
    if (req.headers.get('authorization')) {
      return fetch(new Request(origin(url.pathname + url.search), req));
    }

    // Anonymous agent: require a PROVEN funded wallet (signature validated against the
    // claimed address, EOA or smart wallet, not a trusted header), then qualify.
    const wallet = await verifyWalletProof(env, req, url.pathname);
    if (!wallet) return challenge(env, req.url);

    let verdict: Verdict;
    try {
      verdict = await qualify(env, wallet);
    } catch (e) {
      // Fail closed on RPC error: do not hand out free data when we cannot verify funds.
      return challenge(env, req.url, { rpc_error: String(e) });
    }
    if (!verdict.qualified) return challenge(env, req.url, { verdict });

    // Qualified buyer. Stamp the buyer signal on the REQUEST forwarded downstream, so
    // the origin, a chained Worker, or a payment rule (e.g. an x402 / Monetization
    // Gateway rule) can price against the tier before it ever runs. Also echo it on the
    // response for the calling agent.
    const originReq = new Request(origin(url.pathname + url.search), req);
    originReq.headers.set('x-agent-qualified', 'true');
    originReq.headers.set('x-agent-wallet', wallet);
    originReq.headers.set('x-agent-wallet-type', verdict.wallet_type);
    originReq.headers.set('x-agent-tier', verdict.tier);
    originReq.headers.set('x-agent-intent-score', String(verdict.intent_score));
    const res = await fetch(originReq);
    const out = new Response(res.body, res);
    out.headers.set('x-agent-qualified', 'true');
    out.headers.set('x-agent-wallet', wallet);
    out.headers.set('x-agent-wallet-type', verdict.wallet_type);
    out.headers.set('x-agent-usdc-balance', String(verdict.usdc_balance));
    out.headers.set('x-agent-tier', verdict.tier);
    out.headers.set('x-agent-intent-score', String(verdict.intent_score));
    out.headers.set('x-agent-free-credits', String(verdict.free_credits)); // grant scales with intent; real metering via the x402 layer
    return out;
  },
};
