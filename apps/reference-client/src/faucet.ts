/**
 * Best-effort automated testnet faucet claim (setup step). The supported
 * funding path is the manual one (https://faucet.nervos.org — paste a ckt1
 * address, claim); this is a single best-effort attempt against the HTTP API
 * the faucet's own web form posts to, discovered from its frontend bundle:
 *
 *   POST https://faucet-api.nervos.org/claim_events
 *   { "claim_event": { "address_hash": "<ckt1…>", "amount": "10000" } }
 *
 * Any failure (network, captcha policy change, empty faucet) is non-fatal:
 * the caller falls back to manual instructions + polling.
 */

const FAUCET_API_URL = "https://faucet-api.nervos.org/claim_events";
const DEFAULT_CLAIM_CKB = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

export interface FaucetClaimResult {
  ok: boolean;
  detail: string;
}

export async function tryFaucetClaim(
  address: string,
  amountCkb: number = DEFAULT_CLAIM_CKB,
): Promise<FaucetClaimResult> {
  let response: Response;
  try {
    response = await fetch(FAUCET_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claim_event: { address_hash: address, amount: String(amountCkb) },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      detail: `request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (response.ok) {
    return { ok: true, detail: `claim accepted (HTTP ${response.status})` };
  }
  let body = "";
  try {
    body = (await response.text()).slice(0, 300);
  } catch {
    // ignore — the status line is enough
  }
  return { ok: false, detail: `HTTP ${response.status}${body === "" ? "" : `: ${body}`}` };
}
