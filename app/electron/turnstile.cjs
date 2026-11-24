const { createHash } = require("node:crypto");

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const TURNSTILE_ACTION = "agent_login";
const TOKEN_TTL_MS = 5 * 60 * 1000;

function createTurnstile(hostname) {
  const siteKey = (process.env.OCTOPUS_TURNSTILE_SITE_KEY ?? "").trim();
  const secret = (process.env.OCTOPUS_TURNSTILE_SECRET_KEY ?? "").trim();
  if (!siteKey || !secret) {
    throw new Error("Set OCTOPUS_TURNSTILE_SITE_KEY and OCTOPUS_TURNSTILE_SECRET_KEY to enable Agent server sign-in.");
  }

  const pending = new Set();
  const redeemed = new Map();
  const refuse = () => new Error("Complete a new human verification and try again.");

  async function verify(token) {
    if (typeof token !== "string" || !token.trim() || token.length > 2048) throw refuse();
    const digest = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    for (const [key, expiresAt] of redeemed) {
      if (expiresAt > now) break;
      redeemed.delete(key);
    }
    if (pending.has(digest) || redeemed.has(digest)) throw refuse();

    pending.add(digest);
    try {
      let result;
      try {
        const response = await fetch(`${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`, {
          method: "POST",
          body: new URLSearchParams({ secret, response: token }),
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Siteverify request failed.");
        result = await response.json();
      } catch {
        throw Object.assign(new Error("Human verification is temporarily unavailable. Try again."), { code: "turnstile_unavailable" });
      }

      if (result?.success !== true || result.hostname !== hostname || result.action !== TURNSTILE_ACTION) throw refuse();
      redeemed.set(digest, Date.now() + TOKEN_TTL_MS);
    } finally {
      pending.delete(digest);
    }
  }

  return { siteKey, verify };
}

module.exports = { createTurnstile, TURNSTILE_ORIGIN };
