// Minimal hash-free router using history API.
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
    setPath(to);
  };
  return [path, navigate];
}
