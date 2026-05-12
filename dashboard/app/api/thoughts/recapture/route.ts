import { NextResponse } from "next/server";
import { getSession } from "../../../../lib/auth";
import { callTool } from "../../../../lib/mcp";

export async function POST(req: Request) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as { content?: string };
  if (typeof body.content !== "string" || !body.content.trim()) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    const result = await callTool("capture_thought", { content: body.content });
    return NextResponse.json({ ok: true, text: result.text });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502 },
    );
  }
}
