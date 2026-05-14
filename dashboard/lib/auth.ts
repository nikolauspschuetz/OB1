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
  const cookieDomain = process.env.OB1_COOKIE_DOMAIN || undefined;
  c.set(COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    // Browsers treat *.localhost as a "secure context" so Secure-flag
    // cookies work fine there. Outside localhost, only enable in prod
    // (when served behind real HTTPS).
    secure: process.env.NODE_ENV === "production" &&
      !cookieDomain?.endsWith("localhost"),
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const c = await cookies();
  const cookieDomain = process.env.OB1_COOKIE_DOMAIN || undefined;
  // Set an expired same-shape cookie so it's actually cleared in the
  // browser even when scoped to a parent domain.
  c.set(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });
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
