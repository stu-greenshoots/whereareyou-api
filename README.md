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
## Rate limiting and enumeration defence

**A failed resolve costs 30x a successful one.** That ratio is the whole
mechanism, not a tuning knob — the config refuses to start if a miss is priced
at or below a hit.

Request volume does not separate an attacker from a dispatcher. A control room
during a major incident may resolve codes faster than someone guessing at them,
and a patient attacker stays under any volume threshold you pick. What separates
them is the **miss rate**. A dispatcher is reading a code aloud from a caller:
they almost always hit. Someone walking the codespace almost always misses —
the misses are not a side effect of the attack, they *are* the attack. So the
price goes on the miss, and the limiter never has to decide who anyone is.

With the defaults, per source, per minute:

| | |
|---|---|
| Budget | 600 units |
| Successful resolve | 1 unit → 600 before the limit bites |
| Failed resolve | 30 units → **20** before the limit bites |
| Consecutive misses before backoff | 5 |
| Backoff | 2s, doubling per further miss, capped at 300s |

A miss is any of: unknown code, malformed code, bad API key, or a code claimed
by another control room. All four are things a dispatcher essentially never
does and enumeration does constantly.

Limits apply on two axes — source IP and resolver key — because they catch
different attacks. One host grinding the codespace is caught by IP; a leaked
control-room key used from everywhere is caught by the key.

**Probing while blocked escalates the block.** A 429 that recorded nothing
would freeze the miss streak at the threshold and leave a fixed 2s penalty an
attacker could sleep through. Hammering through a 429 is also about the
clearest statement of intent available: a dispatcher honours `Retry-After`.

**Minting is deliberately barely limited** (120/min/IP, and no miss concept —
minting cannot miss). The failure modes are not symmetric: absorbing junk
sessions costs disk, throttling someone pressing the button because they are in
trouble costs something we will not trade for tidier metrics. An address whose
resolve budget is fully exhausted can still mint.

**The limiter fails open.** If the counter store is unreachable the choice is
between letting some enumeration through and refusing to resolve codes at all.
A dispatcher unable to locate someone because a Redis fell over is not a trade
this system makes. The degraded state is logged at error level.

Set `REDIS_URL` and counters are shared across instances and survive restarts —
without it they are per-process, so an attacker resets their own budget at every
deploy. `TRUST_PROXY` is off by default: with no proxy in front, honouring
`X-Forwarded-For` lets a caller mint a fresh rate-limit identity per request and
walk straight through the per-IP budget.

Throttled requests get `429` with the protocol's `rate-limited` error code and a
`Retry-After` header.

## Known gaps

⚠️ **The in-memory store is policy-only.** It is kept so the suite needs no
Redis, and it warns loudly at startup. Do not deploy it.

⚠️ **No rate limiting.** In `open` mode the resolver is genuinely enumerable.

Also missing: SSE streaming for live sessions, a separate audit log sink, and
docker-compose.

## Licence

MIT.
