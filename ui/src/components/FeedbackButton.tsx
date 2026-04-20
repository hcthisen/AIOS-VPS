import React from "react";

export type ActionState = "idle" | "working" | "ok" | "error";

export function FeedbackButton({
  state,
  idleLabel,
  workingLabel,
  okLabel,
  onClick,
  disabled,
  className,
}: {
  state: ActionState;
  idleLabel: string;
  workingLabel: string;
  okLabel: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const label = state === "working" ? workingLabel : state === "ok" ? okLabel : idleLabel;
  const classes = [className || "", state === "ok" ? "flash-ok" : "", state === "working" ? "is-working" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} onClick={onClick} disabled={disabled || state === "working"} type="button">
      {label}
    </button>
  );
}

export function useActionRunner() {
  const [actions, setActions] = React.useState<Record<string, ActionState>>({});
  const setActionState = (key: string, state: ActionState) =>
    setActions((current) => ({ ...current, [key]: state }));
  const run = async (key: string, work: () => Promise<void>, onError?: (msg: string) => void) => {
    setActionState(key, "working");
    try {
      await work();
      setActionState(key, "ok");
      window.setTimeout(() => setActionState(key, "idle"), 1400);
      return true;
    } catch (e: any) {
      if (onError) onError(e?.message || String(e));
      setActionState(key, "error");
      window.setTimeout(() => setActionState(key, "idle"), 1800);
      return false;
    }
  };
  return { actions, run };
}
