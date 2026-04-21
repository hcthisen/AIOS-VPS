import React from "react";

export function IconButton({
  onClick,
  children,
  disabled,
  danger,
  title,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  const classes = ["icon-btn"];
  if (danger) classes.push("danger");
  return (
    <button
      className={classes.join(" ")}
      onClick={onClick}
      disabled={disabled}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}
