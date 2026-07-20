import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The TTL tests spend real wall-clock seconds waiting for Redis to expire a
    // key. That waiting IS the test — there is no way to prove a record vanishes
    // on its own without letting time actually pass — so the default 5s timeout
    // is not enough.
    testTimeout: 20_000,
    // Redis is a single shared keyspace. Codes are random so collisions are
    // vanishingly unlikely, but serialising removes the question entirely.
    fileParallelism: false,
  },
});
