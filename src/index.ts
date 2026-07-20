import cors from '@fastify/cors';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
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

await app.register(cors, {
  origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
});

registerRoutes(app, config, selected.store, { structuralExpiry: selected.structuralExpiry });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
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

  if (config.resolverMode === 'open') {
    app.log.warn(
      'RESOLVER_MODE=open — anyone can resolve any code, and claim-on-read is disabled. Demo only.',
    );
  }
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}
