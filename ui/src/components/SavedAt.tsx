import React, { useEffect, useState } from "react";

export function SavedAt({ at }: { at: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [at]);
  if (!at) return null;
  const diff = Math.max(0, now - at);
  const label = diff < 10_000 ? "just now" : diff < 60_000 ? `${Math.floor(diff / 1000)}s ago` :
    diff < 3_600_000 ? `${Math.floor(diff / 60_000)}m ago` :
    new Date(at).toLocaleTimeString();
  return <span className="saved-at">Saved {label}</span>;
}
