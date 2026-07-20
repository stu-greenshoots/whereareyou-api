import { DEFAULT_POLICY, type RateLimitPolicy } from './rate-limit.js';

/**
 * Resolver access mode.
 *
 * `open`   — anyone may resolve any code. Frictionless for demos, and
 *            materially insecure: it is exactly the enumeration surface the
 *            protocol is designed to deny. Claiming is disabled in this mode
 *            (an unauthenticated caller has no identity to bind a code to), so
 *            the anti-harvest control is off too.
 * `apikey` — resolvers present a bearer key. The documented default for
 *            anything real.
 */
export type ResolverMode = 'open' | 'apikey';

export interface Config {
  port: number;
  host: string;
  resolverMode: ResolverMode;
  /** key -> resolver identity, used for claim binding and the audit log. */
  apiKeys: Map<string, string>;
  defaultTtlSeconds: number;
  minTtlSeconds: number;
  maxTtlSeconds: number;
  corsOrigins: string[];
  /**
   * Redis connection string. One variable, two consequences, and both matter.
   *
   * For the session store: absent selects the in-memory store, which does NOT
   * deliver structural expiry — see the warning in `store.ts`. Present makes
   * Redis mandatory, and if it will not connect the process refuses to start
   * rather than falling back and quietly weakening its own guarantee.
   *
   * For rate limiting: present means counters survive a restart and are shared
   * across instances — which they must be, or an attacker resets their own
   * budget by waiting for a deploy. Absent means in-process counters: fine for
   * a single-node demo, not for anything real.
   *
   * The rate limiter borrows the store's connection rather than opening its
   * own; see `SelectedStore.redis`.
   */
  redisUrl: string | undefined;
  rateLimit: RateLimitConfig;
}

export interface RateLimitConfig {
  /**
   * Off is a legitimate choice for local development, and a terrible one
   * anywhere else. The server says so at startup.
   */
  enabled: boolean;
  policy: RateLimitPolicy;
  /**
   * Trust `X-Forwarded-For` when deriving the client IP.
   *
   * Off by default and that default matters: behind no proxy, an attacker who
   * can set the header can mint themselves a fresh rate-limit identity on every
   * request, which turns the per-IP budget into decoration.
   */
  trustProxy: boolean;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

function loadRateLimit(): RateLimitConfig {
  const policy: RateLimitPolicy = {
    resolveWindowSeconds: int('RATE_RESOLVE_WINDOW_SECONDS', DEFAULT_POLICY.resolveWindowSeconds),
    resolveBudget: int('RATE_RESOLVE_BUDGET', DEFAULT_POLICY.resolveBudget),
    resolveHitCost: int('RATE_RESOLVE_HIT_COST', DEFAULT_POLICY.resolveHitCost),
    resolveMissCost: int('RATE_RESOLVE_MISS_COST', DEFAULT_POLICY.resolveMissCost),
    mintWindowSeconds: int('RATE_MINT_WINDOW_SECONDS', DEFAULT_POLICY.mintWindowSeconds),
    mintBudget: int('RATE_MINT_BUDGET', DEFAULT_POLICY.mintBudget),
    missStreakThreshold: int('RATE_MISS_STREAK_THRESHOLD', DEFAULT_POLICY.missStreakThreshold),
    backoffBaseSeconds: int('RATE_BACKOFF_BASE_SECONDS', DEFAULT_POLICY.backoffBaseSeconds),
    backoffMaxSeconds: int('RATE_BACKOFF_MAX_SECONDS', DEFAULT_POLICY.backoffMaxSeconds),
    missStreakMemorySeconds: int(
      'RATE_MISS_STREAK_MEMORY_SECONDS',
      DEFAULT_POLICY.missStreakMemorySeconds,
    ),
  };

  // The entire enumeration defence rests on a miss being dearer than a hit. A
  // configuration where it is not has silently turned this back into an
  // ordinary volume limiter, so refuse it rather than let it look configured.
  if (policy.resolveMissCost <= policy.resolveHitCost) {
    throw new Error(
      'RATE_RESOLVE_MISS_COST must exceed RATE_RESOLVE_HIT_COST — pricing misses above ' +
        'hits is the mechanism, not a tuning knob. Equal costs make this a plain ' +
        'requests-per-minute limiter, which does not distinguish a dispatcher from a ' +
        'code guesser.',
    );
  }

  return {
    enabled: bool('RATE_LIMIT_ENABLED', true),
    policy,
    trustProxy: bool('TRUST_PROXY', false),
  };
}

/**
 * `API_KEYS` format: `key:identity,key:identity`.
 * Example: `demo-key-alpha:control-room-a,demo-key-bravo:control-room-b`
 */
function parseApiKeys(raw: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  if (!raw) return keys;
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      throw new Error(`API_KEYS entry must be "key:identity", got ${JSON.stringify(trimmed)}`);
    }
    keys.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return keys;
}

export function loadConfig(): Config {
  const resolverMode = (process.env['RESOLVER_MODE'] ?? 'open') as ResolverMode;
  if (resolverMode !== 'open' && resolverMode !== 'apikey') {
    throw new Error(`RESOLVER_MODE must be "open" or "apikey", got ${JSON.stringify(resolverMode)}`);
  }

  const apiKeys = parseApiKeys(process.env['API_KEYS']);
  // Fail fast rather than starting a resolver nobody can authenticate against.
  if (resolverMode === 'apikey' && apiKeys.size === 0) {
    throw new Error('RESOLVER_MODE=apikey requires at least one entry in API_KEYS');
  }

  const minTtlSeconds = int('MIN_TTL_SECONDS', 60);
  const maxTtlSeconds = int('MAX_TTL_SECONDS', 4 * 60 * 60);
  const defaultTtlSeconds = int('DEFAULT_TTL_SECONDS', 30 * 60);
  if (minTtlSeconds > maxTtlSeconds) {
    throw new Error('MIN_TTL_SECONDS cannot exceed MAX_TTL_SECONDS');
  }

  return {
    port: int('PORT', 8787),
    host: process.env['HOST'] ?? '0.0.0.0',
    resolverMode,
    apiKeys,
    defaultTtlSeconds,
    minTtlSeconds,
    maxTtlSeconds,
    corsOrigins: (process.env['CORS_ORIGINS'] ?? '*').split(',').map((o) => o.trim()),
    redisUrl: process.env['REDIS_URL'] === '' ? undefined : process.env['REDIS_URL'],
    rateLimit: loadRateLimit(),
  };
}
