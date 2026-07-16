// Entrypoint: configure logging, then start the gateway.

import { configureLogging } from './runtime/logger.js';
import { startGateway } from './gateway.js';

configureLogging();

startGateway().catch((e) => {
  console.error('[fatal] gateway failed to start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
