import { NextResponse } from "next/server";
import { getSession } from "../../../../lib/auth";
import { archiveChat, renameChat } from "../../../../lib/chat";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const chatId = parseInt(id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const body = (await req.json()) as { title?: string };
  if (typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  await renameChat(chatId, body.title.trim().slice(0, 200));
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const chatId = parseInt(id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  await archiveChat(chatId);
  return NextResponse.json({ ok: true });
}
