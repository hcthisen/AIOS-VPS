import React, { useEffect, useState } from "react";
import { api } from "../api";

interface TimeSnapshot {
  serverNow: number;
  timezoneOffsetMinutes: number;
  timezoneLabel: string;
}

export function ServerClock() {
  const [snapshot, setSnapshot] = useState<TimeSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      try {
        const next = await api<TimeSnapshot>("/api/settings/time");
        if (!canceled) {
          setSnapshot(next);
          setReceivedAt(Date.now());
        }
      } catch {
        if (!canceled) setSnapshot(null);
      }
    };
    load();
    const onChanged = () => { load(); };
    window.addEventListener("aios-time-settings-changed", onChanged);
    const refreshTimer = window.setInterval(load, 60_000);
    const tickTimer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      canceled = true;
      window.removeEventListener("aios-time-settings-changed", onChanged);
      window.clearInterval(refreshTimer);
      window.clearInterval(tickTimer);
    };
  }, []);

  if (!snapshot) return null;

  const now = snapshot.serverNow + (Date.now() - receivedAt);
  return (
    <span className="server-clock" title={`Scheduler timezone: ${snapshot.timezoneLabel}`}>
      {formatFixedOffsetTime(now, snapshot.timezoneOffsetMinutes)} {snapshot.timezoneLabel}
    </span>
  );
}

export function formatFixedOffsetTime(epochMs: number, offsetMinutes: number): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
