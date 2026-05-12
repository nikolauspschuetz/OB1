import { NextResponse } from "next/server";
import { checkPassword, setSessionCookie } from "../../../lib/auth";

function publicOrigin(req: Request): string {
  const xfHost = req.headers.get("x-forwarded-host");
  const xfProto = req.headers.get("x-forwarded-proto");
  const host = xfHost ?? req.headers.get("host") ?? "localhost";
  const proto = xfProto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/");
  const origin = publicOrigin(req);
  if (!checkPassword(password)) {
    return NextResponse.redirect(`${origin}/login?error=bad`, { status: 303 });
  }
  await setSessionCookie();
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(`${origin}${safeNext}`, { status: 303 });
}
