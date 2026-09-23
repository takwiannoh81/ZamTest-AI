import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** Fetches `path` and refreshes it every `intervalMs` (0 = no polling). */
export function usePoll<T>(path: string | null, intervalMs = 3000) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = () =>
      api<T>(path)
        .then((d) => {
          if (alive) {
            setData(d);
            setError(undefined);
          }
        })
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const timer = intervalMs ? setInterval(load, intervalMs) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [path, intervalMs, tick]);

  return { data, error, reload };
}

export function useHashRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [route, (to: string) => (window.location.hash = to)];
}

export function timeAgo(iso?: string): string {
  if (!iso) return "-";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function duration(start?: string, end?: string): string {
  if (!start) return "-";
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
