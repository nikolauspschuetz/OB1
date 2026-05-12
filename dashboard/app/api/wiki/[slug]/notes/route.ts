import { NextResponse } from "next/server";
import { getSession } from "../../../../../lib/auth";
import { sql } from "../../../../../lib/db";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { slug } = await params;
  const body = (await req.json()) as { notes?: string };
  const notes = typeof body.notes === "string" ? body.notes : "";
  const updated = await sql<Array<{ slug: string }>>`
    UPDATE wiki_pages
       SET notes = ${notes || null}, updated_at = now()
     WHERE slug = ${slug}
     RETURNING slug
  `;
  if (!updated.length) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
