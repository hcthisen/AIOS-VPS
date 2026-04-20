import React from "react";

export function Banner({
  kind = "info",
  onDismiss,
  children,
}: {
  kind?: "info" | "ok" | "warn" | "err";
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`banner ${kind}`} role={kind === "err" ? "alert" : "status"}>
      <div className="banner-body">{children}</div>
      {onDismiss ? (
        <button className="close" aria-label="Dismiss" onClick={onDismiss}>{"\u00d7"}</button>
      ) : null}
    </div>
  );
}
