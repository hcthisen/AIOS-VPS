// Minimal hash-free router using history API.
// Stored state is always `window.location.pathname`; query strings live on the
// URL and components read them directly via `window.location.search`.
import { useEffect, useState } from "react";

export function useRoute(): [string, (to: string) => void] {
  const [path, setPath] = useState<string>(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string) => {
    window.history.pushState({}, "", to);
    const qIdx = to.indexOf("?");
    setPath(qIdx >= 0 ? to.slice(0, qIdx) : to);
    // Dispatch a popstate so components that sync with search params get notified.
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return [path, navigate];
}
