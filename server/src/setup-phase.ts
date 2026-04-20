import { kvGet, kvSet } from "./db";

export type SetupPhase =
  | "admin_setup"
  | "domain_setup"
  | "provider_setup"
  | "github_setup"
  | "repo_setup"
  | "notifications"
  | "complete";

const PHASES: SetupPhase[] = [
  "admin_setup",
  "domain_setup",
  "provider_setup",
  "github_setup",
  "repo_setup",
  "notifications",
  "complete",
];

const KEY = "setup.phase";

export function getSetupPhase(): SetupPhase {
  return (kvGet(KEY) as SetupPhase) || "admin_setup";
}

export function setSetupPhase(phase: SetupPhase) {
  if (!PHASES.includes(phase)) throw new Error(`invalid phase: ${phase}`);
  kvSet(KEY, phase);
}

export function advanceSetupPhase(from: SetupPhase): SetupPhase {
  const current = getSetupPhase();
  // Only advance if current matches the claimed "from"; avoids regressing on re-run.
  if (current !== from) return current;
  const idx = PHASES.indexOf(current);
  const next = PHASES[Math.min(idx + 1, PHASES.length - 1)];
  setSetupPhase(next);
  return next;
}
