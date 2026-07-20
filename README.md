# whereareyou-api

**Reference resolver node for the [whereareyou](https://github.com/stu-greenshoots/whereareyou-protocol)
location handover protocol.**

Mints short location codes, resolves them for dispatchers, and lets them expire.

> ⚠️ Early prototype. Not deployed, not audited, not fit for real emergency use.

## Run it

```bash
npm install
npm run dev          # http://localhost:8787
```

```bash
curl localhost:8787/health
```

## Endpoints

| | |
|---|---|
| `POST /v1/sessions` | Mint. Returns code, display form, phonetic form, expiry, update token |
| `GET /v1/sessions/{code}` | Resolve. Claims the code for the resolving control room |
| `PATCH /v1/sessions/{code}` | Update position on a live session |
| `DELETE /v1/sessions/{code}` | Sharer revokes |
| `GET /health` | Liveness and live session count |

Codes are parsed permissively — spoken, spaced, hyphenated, lowercase all work:

```bash
curl "localhost:8787/v1/sessions/X-ray%20Seven%20Kilo%20Nine%20Papa%20Two%20Quebec%20Four"
```

## Access modes

Set `RESOLVER_MODE` (see `.env.example`):

**`open`** — anyone may resolve any code. Frictionless for demos and materially
insecure. Claim-on-read is disabled, because an unauthenticated caller has no
identity to bind a code to. The API logs a warning on startup and every response
carries a warning field.

**`apikey`** — resolvers present a bearer key. The default for anything real.

```bash
RESOLVER_MODE=apikey API_KEYS="key-alpha:control-room-a" npm run dev
curl -H "Authorization: Bearer key-alpha" localhost:8787/v1/sessions/X7K9P2Q4
```

## Design notes

**Claim-on-first-read.** In `apikey` mode the first control room to resolve a
code owns it; anyone else gets **404, not 403**. A 403 would confirm to a
guesser that the code is real, which is exactly the signal enumeration defence
exists to deny. For the same reason, `not-found` covers four distinct
situations — never existed, expired, revoked, claimed elsewhere — and they are
deliberately indistinguishable from outside.

Claiming rather than deleting-on-read is deliberate too: a dispatcher may need
to re-check ten minutes later or hand over to another unit.

**Coordinates never reach the logs.** Redaction is configured before the first
route is registered rather than retrofitted, because retrofitting is how leaks
happen.

**Live updates do not extend expiry.** A live session must not become immortal
simply by continuing to move.

**Expiry is structural, not policy.** See below — this is the one worth reading.

## Session store

```bash
REDIS_URL=redis://localhost:6379 npm run dev
```

Set `REDIS_URL` and sessions live in Redis under a native TTL. Leave it unset
and they live in a `Map` in this process.

That is not a deployment detail. It is the difference between two claims that
sound identical and are not:

- *"We delete records after 30 minutes."* — **policy.** True only for as long as
  something keeps enforcing it. A paused sweeper, a crashed job, a refactor by
  someone who didn't know, and the record is still sitting there.
- *"A record cannot exist for longer than 30 minutes."* — **structural.**
  Nothing has to remember to act. Redis holds the expiry, Redis drops the key,
  and a logically-expired key is never served to any client — regardless of what
  this process is doing, or whether it is running at all.

Only the second survives an audit, and the second is what the protocol's privacy
argument actually rests on. So:

- **There is no sweeper.** No `setInterval`, no cleanup job, no scheduled
  delete. A test asserts this about the source itself, because the constraint is
  easy to break by accident and expensive to notice.
- **Claim state is a field of the session hash**, not a key of its own. Two keys
  would mean two TTLs and two chances to disagree; the record of *who resolved a
  code* physically cannot outlive the code.
- **Writes never extend the TTL**, and an update racing its own expiry cannot
  resurrect a session — the patch is a single atomic Lua step, because a plain
  `HSET` against a vanished key would recreate it *with no expiry at all*.
- **An unreachable Redis is fatal at startup.** Deliberately no fallback to
  memory: a resolver that silently downgraded would carry on advertising a
  guarantee that had stopped being true, which is worse than one that refuses to
  start.

`GET /health` reports `structuralExpiry`, so which of the two claims a running
deployment actually delivers is observable from outside.

`test/store-redis.test.ts` proves the property the only way it can be proved: it
writes a key with a 1.5s TTL, waits, and then asks **`redis-cli`** — not the
application's own client — whether the key still exists.

## Tests

```bash
npm test          # vitest
npm run typecheck
```

The Redis integration tests need a Redis on `redis://127.0.0.1:6379` (override
with `TEST_REDIS_URL`). They skip with a loud warning if none is reachable — a
skipped run means the structural-expiry claim went unverified, which should be
visible rather than buried in a green summary.

## Known gaps

⚠️ **The in-memory store is policy-only.** It is kept so the suite needs no
Redis, and it warns loudly at startup. Do not deploy it.

⚠️ **No rate limiting.** In `open` mode the resolver is genuinely enumerable.

Also missing: SSE streaming for live sessions, a separate audit log sink, and
docker-compose.

## Licence

MIT.
