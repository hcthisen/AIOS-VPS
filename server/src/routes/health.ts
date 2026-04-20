import { Router } from "../http";
import { getSetupPhase } from "../setup-phase";

export function registerHealthRoutes(router: Router) {
  router.get("/api/health", async (req, res) => {
    res.json({ status: "ok", setupPhase: getSetupPhase(), ts: Date.now() });
  });
}
