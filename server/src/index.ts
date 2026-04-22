import { config } from "./config";
import { log } from "./log";
import { createHttpServer, Router } from "./http";
import { sessionMiddleware } from "./auth";
import { registerHealthRoutes } from "./routes/health";
import { registerAuthRoutes } from "./routes/auth";
import { registerVpsSetupRoutes } from "./routes/vps-setup";
import { registerProviderAuthRoutes } from "./routes/provider-auth";
import { registerOnboardingRoutes } from "./routes/github";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerStorageRoutes } from "./routes/storage";
import { attachTerminal } from "./terminal";
import { startHeartbeat } from "./services/heartbeat";
import { maybeServePublicObject } from "./services/publicBaseUrl";

async function main() {
  const router = new Router();
  router.use(sessionMiddleware);

  registerHealthRoutes(router);
  registerAuthRoutes(router);
  registerVpsSetupRoutes(router);
  registerProviderAuthRoutes(router);
  registerOnboardingRoutes(router);
  registerDashboardRoutes(router);
  registerStorageRoutes(router);

  const server = createHttpServer(router, {
    uiDir: config.uiDir,
    onMiss: maybeServePublicObject,
  });
  attachTerminal(server);

  server.listen(config.port, config.host, () => {
    log.info(`aios listening on http://${config.host}:${config.port}`);
    log.info(`data dir: ${config.dataDir}`);
    log.info(`repo dir: ${config.repoDir}`);
    log.info(`ui dir: ${config.uiDir}`);
  });

  // Heartbeat kicks in automatically; it self-gates on setupPhase === "complete".
  startHeartbeat();

  // Graceful shutdown
  const shutdown = (sig: string) => {
    log.info(`received ${sig}; shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
