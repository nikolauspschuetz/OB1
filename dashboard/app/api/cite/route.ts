import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth";
import { sql } from "../../../lib/db";

export async function GET(req: Request) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const short = (url.searchParams.get("short") ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(short)) {
    return NextResponse.json({ error: "bad short" }, { status: 400 });
  }
  // id starts with the 8-char short — use range scan on the prefix.
  const rows = await sql<Array<{ id: string; content: string }>>`
    SELECT id, content FROM thoughts
     WHERE id::text LIKE ${short + "%"}
     LIMIT 1
  `;
  if (!rows.length) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(rows[0]);
}
