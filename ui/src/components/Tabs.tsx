import React from "react";

export interface Tab {
  id: string;
  label: string;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            className={`tab ${t.id === active ? "active" : ""}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <select
        className="tabs-select"
        value={active}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Section"
      >
        {tabs.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
    </>
  );
}
