import React from "react";

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={["section", className].filter(Boolean).join(" ")}>
      {(title || actions) && (
        <div className="section-header">
          {title ? <h3>{title}</h3> : <span />}
          {actions ? <div className="section-actions">{actions}</div> : null}
        </div>
      )}
      {description ? <p className="section-description">{description}</p> : null}
      {children}
    </section>
  );
}
