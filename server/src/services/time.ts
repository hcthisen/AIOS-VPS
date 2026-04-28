import { config } from "../config";

const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

export function normalizeTimezoneOffsetMinutes(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return -new Date().getTimezoneOffset();
  const rounded = Math.round(n / 60) * 60;
  return Math.max(MIN_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, rounded));
}

export function timezoneLabel(offsetMinutes = config.scheduler.timezoneOffsetMinutes): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return minutes
    ? `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
    : `UTC${sign}${String(hours).padStart(2, "0")}`;
}

export function timezoneOffsetToEtcGmt(offsetMinutes = config.scheduler.timezoneOffsetMinutes): string {
  if (offsetMinutes === 0) return "Etc/GMT";
  const hours = offsetMinutes / 60;
  if (!Number.isInteger(hours)) return "Etc/GMT";
  // IANA Etc/GMT signs are intentionally inverted: Etc/GMT-2 means UTC+02.
  return hours > 0 ? `Etc/GMT-${hours}` : `Etc/GMT+${Math.abs(hours)}`;
}

export function schedulerCronOptions(currentDate: Date): { currentDate: Date; tz: string } {
  return {
    currentDate,
    tz: timezoneOffsetToEtcGmt(),
  };
}

export function serverTimeSnapshot(now = Date.now()) {
  return {
    serverNow: now,
    timezoneOffsetMinutes: config.scheduler.timezoneOffsetMinutes,
    timezoneLabel: timezoneLabel(),
    cronTimezone: timezoneOffsetToEtcGmt(),
  };
}
