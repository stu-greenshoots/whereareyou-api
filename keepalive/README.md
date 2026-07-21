# keepalive — Cloudflare Worker

Pings the Render resolver's `/health` on a cron so free-tier cold starts rarely
hit a real visitor. Runs 06:00–23:59 UTC, every 10 minutes.

## Deploy

You already have Cloudflare, so this is two commands:

```bash
cd keepalive
npx wrangler login      # opens a browser once
npx wrangler deploy
```

That's it — the cron is registered on deploy. Check the last run in the
Cloudflare dashboard under **Workers → whereareyou-keepalive → Logs**, or just
open the worker's URL in a browser (it proxies `/health` and reports the
status).

## Tuning

- **Warm for longer:** widen the hours in `wrangler.toml`, e.g. `*/10 * * * *`
  for 24/7. Costs more of Render's ~750 free instance-hours — 24/7 sits right at
  the limit, so only do it if nothing else free is running there.
- **Different service:** change `TARGET` in `worker.js`.

## What this does and doesn't do

Narrows the cold-start window; does not remove it. A missed wake-up, or a
visitor outside the scheduled hours, still cold-starts. The only guaranteed
always-on fix is Render's paid Starter tier (~$7/mo), at which point delete this.
