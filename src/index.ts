import cors from '@fastify/cors';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { registerRoutes } from './routes.js';
import { MemorySessionStore } from './store.js';

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

const store = new MemorySessionStore();

await app.register(cors, {
  origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
});

registerRoutes(app, config, store);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  store.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { resolverMode: config.resolverMode, store: 'memory' },
    'whereareyou resolver node ready',
  );
  if (config.resolverMode === 'open') {
    app.log.warn(
      'RESOLVER_MODE=open — anyone can resolve any code, and claim-on-read is disabled. Demo only.',
    );
  }
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}
