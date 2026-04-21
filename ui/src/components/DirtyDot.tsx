import React from "react";

export function DirtyDot({ dirty, title }: { dirty: boolean; title?: string }) {
  if (!dirty) return null;
  return <span className="dirty-dot" title={title || "Unsaved changes"} aria-label="Unsaved changes" />;
}
