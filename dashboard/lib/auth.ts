// Node-runtime-only helpers — these import next/headers and are safe in
// Server Components and Route Handlers but NOT in edge middleware.
// For edge-safe primitives use lib/auth-crypto.ts.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  checkPassword as _checkPassword,
  SESSION_MAX_AGE_S,
  signSession,
  verifySession,
} from "./auth-crypto";

const COOKIE = "ob1_session";

export async function setSessionCookie(): Promise<void> {
  const value = await signSession();
  const c = await cookies();
  c.set(COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE);
}

export async function getSession(): Promise<boolean> {
  const c = await cookies();
  const token = c.get(COOKIE)?.value;
  if (!token) return false;
  return await verifySession(token);
}

export async function requireSession(): Promise<void> {
  if (!(await getSession())) redirect("/login");
}

export const checkPassword = _checkPassword;
