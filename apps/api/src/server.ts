import { createLogger } from "@workeasy/observability";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const logger = createLogger({ service: "api", level: config.LOG_LEVEL });
const app = createApp({ logger });

const server = app.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, "api listening");
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "api shutting down; draining connections");
  server.close((err) => {
    if (err) {
      logger.error({ err }, "api shutdown failed");
      process.exit(1);
    }
    process.exit(0);
  });
  // Close idle keep-alive sockets so draining does not wait on them.
  server.closeIdleConnections();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
