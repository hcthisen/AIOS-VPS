import { log } from "../log";
import {
  getNotificationConfig,
  getTelegramPairingState,
  primeTelegramPairing,
  recordTelegramPairingUpdates,
  telegramApi,
  TelegramUpdate,
} from "./notifications";
import { dispatchTelegramAgentQueue, processTelegramAgentUpdates } from "./telegramAgent";
import { listCompanies } from "./companies";
import { withCompanyContext } from "../company-context";

let updateTimer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

export function startTelegramUpdates() {
  if (updateTimer) return;
  schedulePoll(500);
}

export function stopTelegramUpdates() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = null;
}

function schedulePoll(delayMs: number) {
  updateTimer = setTimeout(() => {
    void pollLoop();
  }, delayMs);
  updateTimer.unref?.();
}

async function pollLoop() {
  try {
    await pollTelegramUpdatesOnce({ timeout: 20, skipIfBusy: true });
    schedulePoll(500);
  } catch (e: any) {
    log.warn("telegram update poll failed", e?.message || e);
    schedulePoll(5_000);
  }
}

export async function pollTelegramUpdatesOnce(opts: { timeout?: number; skipIfBusy?: boolean } = {}): Promise<{ polled: boolean }> {
  if (inFlight) {
    if (opts.skipIfBusy !== false) return { polled: false };
    await inFlight;
    return { polled: false };
  }
  inFlight = doPollTelegramUpdatesOnce(opts.timeout ?? 0).finally(() => {
    inFlight = null;
  });
  await inFlight;
  return { polled: true };
}

async function doPollTelegramUpdatesOnce(timeout: number) {
  for (const company of listCompanies().filter((entry) => entry.setupPhase === "complete")) {
    await withCompanyContext(company, async () => {
      await doPollCurrentCompanyTelegramUpdates(timeout);
    });
  }
}

async function doPollCurrentCompanyTelegramUpdates(timeout: number) {
  const config = getNotificationConfig();
  if (config.channel !== "telegram" || !config.botToken) return;

  let state = getTelegramPairingState();
  if (!state || state.botToken !== config.botToken) {
    await primeTelegramPairing(config.botToken);
    state = getTelegramPairingState();
  }

  const updates = await telegramApi<TelegramUpdate[]>(config.botToken, "getUpdates", {
    offset: state?.offset ?? 0,
    timeout,
    limit: 50,
    allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"],
  });

  recordTelegramPairingUpdates(config.botToken, updates);
  await processTelegramAgentUpdates(updates);
  await dispatchTelegramAgentQueue();
}
