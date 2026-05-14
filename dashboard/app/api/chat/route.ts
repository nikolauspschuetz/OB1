import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth";
import { createChat, deriveTitle } from "../../../lib/chat";

// POST /api/chat — create a new chat. Body { title? }. Returns { id }.
export async function POST(req: Request) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let title: string | null = null;
  try {
    const body = (await req.json()) as { title?: string };
    if (typeof body.title === "string" && body.title.trim()) {
      title = deriveTitle(body.title);
    }
  } catch {
    /* empty body is fine — title derived from first turn instead */
  }
  const id = await createChat(title);
  return NextResponse.json({ id });
}
