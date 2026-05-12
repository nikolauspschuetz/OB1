import { NextResponse } from "next/server";
import { clearSessionCookie } from "../../../lib/auth";

function publicOrigin(req: Request): string {
  const xfHost = req.headers.get("x-forwarded-host");
  const xfProto = req.headers.get("x-forwarded-proto");
  const host = xfHost ?? req.headers.get("host") ?? "localhost";
  const proto = xfProto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  await clearSessionCookie();
  return NextResponse.redirect(`${publicOrigin(req)}/login`, { status: 303 });
}
