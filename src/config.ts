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
  };
}
