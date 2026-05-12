import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "./lib/auth-crypto";

// Proxy (formerly middleware in Next ≤15) does the *fast* check:
// cookie present and HMAC valid. Page-level requireSession() still
// runs as defense in depth.
const PUBLIC = new Set<string>([
  "/login",
  "/api/login",
]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (
    PUBLIC.has(pathname) ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }
  const token = req.cookies.get("ob1_session")?.value;
  if (token && (await verifySession(token))) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next|favicon).*)"],
};
