import { NextResponse } from "next/server";
import { getSession } from "../../../../../lib/auth";
import { sql } from "../../../../../lib/db";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const entityId = parseInt(id, 10);
  if (!Number.isFinite(entityId) || entityId <= 0) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const body = (await req.json()) as { pinned?: boolean };
  if (typeof body.pinned !== "boolean") {
    return NextResponse.json({ error: "pinned must be boolean" }, { status: 400 });
  }
  await sql`
    UPDATE entities SET pinned = ${body.pinned}, updated_at = now()
     WHERE id = ${entityId}::bigint
  `;
  return NextResponse.json({ ok: true, pinned: body.pinned });
}
