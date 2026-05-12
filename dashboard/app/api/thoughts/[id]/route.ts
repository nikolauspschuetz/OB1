import { NextResponse } from "next/server";
import { getSession } from "../../../../lib/auth";
import { env } from "../../../../lib/env";
import { callTool } from "../../../../lib/mcp";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const body = (await req.json()) as { content?: string; reason?: string };
  if (typeof body.content !== "string" || !body.content.trim()) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    const result = await callTool("update_thought", {
      id,
      content: body.content,
      reason: body.reason ?? "dashboard-edit",
    });
    return NextResponse.json({ ok: true, text: result.text });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502 },
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  try {
    const resp = await fetch(`${env.OB1_MCP_URL}/thoughts/${id}`, {
      method: "DELETE",
      headers: { "x-brain-key": env.OB1_MCP_KEY },
    });
    if (!resp.ok) {
      const body = await resp.text();
      return NextResponse.json(
        { error: `delete failed: ${resp.status} ${body.slice(0, 200)}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502 },
    );
  }
}
