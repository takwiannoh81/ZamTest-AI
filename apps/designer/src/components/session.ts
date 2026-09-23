import { useEffect, useState } from "react";
import { api, setToken } from "../api";

export type Role = "admin" | "developer" | "operator" | "viewer";

export interface Me {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** "open" = local development without sign-in. */
  kind: "user" | "token" | "open";
}

const ORDER: Role[] = ["viewer", "operator", "developer", "admin"];
export const atLeast = (me: Me | undefined, role: Role) => !!me && ORDER.indexOf(me.role) >= ORDER.indexOf(role);

let cached: Promise<Me> | undefined;

/** The signed-in user (fetched once per page load). */
export function useMe(): Me | undefined {
  const [me, setMe] = useState<Me>();
  useEffect(() => {
    cached ??= api<Me>("/api/auth/me");
    cached.then(setMe).catch(() => undefined);
  }, []);
  return me;
}

export async function signOut(): Promise<void> {
  await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  setToken("");
  window.location.reload();
}
