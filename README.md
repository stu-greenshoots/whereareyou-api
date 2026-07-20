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

## Known gaps

⚠️ **Sessions live in memory.** Restarting drops every live code, and expiry is
enforced by a sweeper rather than being structurally impossible. The protocol's
privacy argument depends on expiry being *structural* — Redis with native TTL —
so treat that claim as unmet until the store is swapped.

⚠️ **No rate limiting.** In `open` mode the resolver is genuinely enumerable.

Also missing: SSE streaming for live sessions, a separate audit log sink, and
docker-compose.

## Licence

MIT.
