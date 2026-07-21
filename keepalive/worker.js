/**
 * Keep the Render free-tier resolver warm.
 *
 * Render spins a free web service down after ~15 minutes idle, and the next
 * request then waits 30–50s for a cold start. This worker pokes the health
 * endpoint on a cron so a real visitor rarely hits that.
 *
 * It runs only during waking hours (see the cron in wrangler.toml), so the
 * service is allowed to sleep overnight and the whole thing stays inside
 * Render's ~750 free instance-hours per month. Warm when people use it, asleep
 * when they don't.
 *
 * This narrows the cold-start window; it does not remove it. If a wake-up is
 * missed, or someone visits outside the scheduled hours, they still cold-start.
 * The only real fix for that is Render's paid always-on tier.
 */

const TARGET = 'https://whereareyou-api.onrender.com/health';

export default {
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(
      fetch(TARGET, { method: 'GET', cf: { cacheTtl: 0 } })
        .then((r) => console.log(`keepalive ${TARGET} → ${r.status}`))
        .catch((e) => console.log(`keepalive failed: ${e}`)),
    );
  },

  // Also answer normal requests, so you can hit the worker's URL yourself to
  // confirm it's deployed and see when it last ran.
  async fetch() {
    const r = await fetch(TARGET);
    return new Response(`keepalive worker ok — upstream /health returned ${r.status}\n`, {
      headers: { 'content-type': 'text/plain' },
    });
  },
};
