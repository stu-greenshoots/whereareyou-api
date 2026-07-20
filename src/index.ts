import cors from '@fastify/cors';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import {
  MemoryRateLimitBackend,
  RateLimiter,
  RedisRateLimitBackend,
  type RateLimitBackend,
} from './rate-limit.js';
import { registerRoutes } from './routes.js';
import { createStore, type SelectedStore } from './store-factory.js';

const config = loadConfig();

const app = Fastify({
  logger: {
    level: process.env['LOG_LEVEL'] ?? 'info',
    // Coordinates must never reach the logs. Configured before the first route
    // exists rather than retrofitted, because retrofitting is how leaks happen.
    redact: {
      paths: ['req.body.position', 'res.body.position', 'req.body.updateToken'],
      censor: '[redacted]',
    },
  },
  // Off unless explicitly enabled. With no proxy in front, honouring
  // X-Forwarded-For would let a caller mint a fresh rate-limit identity per
  // request and walk straight through the per-IP budget.
  trustProxy: config.rateLimit.trustProxy,
});

// Selected before the server listens, so an unreachable Redis stops the process
// rather than producing a resolver that is up but no longer keeping its
// promises.
let selected: SelectedStore;
try {
  selected = await createStore(config.redisUrl);
} catch (error) {
  app.log.fatal(
    error,
    'REDIS_URL is set but Redis is unreachable — refusing to start. This is deliberately ' +
      'not a condition to fall back from: the in-memory store cannot provide structural ' +
      'expiry, so starting anyway would mean advertising a guarantee that had stopped ' +
      'being true.',
  );
  process.exit(1);
}

let limiter: RateLimiter | undefined;

if (config.rateLimit.enabled) {
  // Share the store's connection rather than opening a second one. Both
  // subsystems need Redis for the same reason and their key prefixes do not
  // collide; a separate socket would only add another retry strategy and
  // another failure mode to reason about.
  const backend: RateLimitBackend =
    selected.redis !== undefined
      ? new RedisRateLimitBackend(selected.redis)
      : new MemoryRateLimitBackend();
  limiter = new RateLimiter(backend, config.rateLimit.policy, app.log);
}

await app.register(cors, {
  origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
});

registerRoutes(app, config, selected.store, {
  structuralExpiry: selected.structuralExpiry,
  limiter,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  // Closes the shared connection, which the limiter was borrowing.
  await selected.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });

  app.log.info(
    {
      resolverMode: config.resolverMode,
      store: selected.kind,
      structuralExpiry: selected.structuralExpiry,
      rateLimiting: config.rateLimit.enabled,
      rateLimitBackend: selected.redis !== undefined ? 'redis' : 'memory',
    },
    `whereareyou resolver node ready — session store: ${selected.kind.toUpperCase()}`,
  );

  // Say plainly, at every startup, whether this deployment actually delivers the
  // property the protocol documentation claims. An operator should never have to
  // infer it from the config.
  if (selected.structuralExpiry) {
    app.log.info(
      'STORE=redis — expiry is STRUCTURAL. Session records are held under a native Redis ' +
        'TTL and cannot outlive it. There is no sweeper.',
    );
  } else {
    app.log.warn(
      'STORE=memory — expiry is POLICY ONLY, not structural. Sessions live in this ' +
        "process's heap and are removed by a sweeper, so the bytes linger between sweeps " +
        'and a restart drops every live code. Set REDIS_URL to get the guarantee the ' +
        'protocol documentation describes. Do not run this configuration anywhere real.',
    );
  }

  if (config.rateLimit.enabled) {
    const { policy } = config.rateLimit;
    app.log.info(
      {
        budget: policy.resolveBudget,
        windowSeconds: policy.resolveWindowSeconds,
        hitCost: policy.resolveHitCost,
        missCost: policy.resolveMissCost,
        missesToExhaust: Math.ceil(policy.resolveBudget / policy.resolveMissCost),
        hitsToExhaust: Math.ceil(policy.resolveBudget / policy.resolveHitCost),
      },
      `enumeration defence active — a failed resolve costs ${
        policy.resolveMissCost / policy.resolveHitCost
      }x a successful one`,
    );
    if (selected.redis === undefined) {
      app.log.warn(
        'rate-limit counters are in-process — they reset on restart and are not shared ' +
          'between instances. Set REDIS_URL for limits that actually hold.',
      );
    }
  } else {
    app.log.warn(
      'RATE_LIMIT_ENABLED=false — no enumeration defence. The resolver can be walked ' +
        'through the codespace. Local development only.',
    );
  }

  if (config.resolverMode === 'open') {
    app.log.warn(
      'RESOLVER_MODE=open — anyone can resolve any code, and claim-on-read is disabled. Demo only.',
    );
  }
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}
