import { NextResponse } from "next/server";
import { getSession } from "../../../../lib/auth";
import { callTool } from "../../../../lib/mcp";

export async function POST(req: Request) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Dashboard names them survivor/loser (clearer to humans); the MCP
  // tool names them target/source. Translate here.
  const body = (await req.json()) as { survivor_id?: number; loser_id?: number };
  const survivor = Number(body.survivor_id);
  const loser = Number(body.loser_id);
  if (!Number.isFinite(survivor) || !Number.isFinite(loser) || survivor === loser) {
    return NextResponse.json(
      { error: "survivor_id and loser_id required and must differ" },
      { status: 400 },
    );
  }
  try {
    const result = await callTool("merge_entities", {
      source_id: loser,
      target_id: survivor,
    });
    return NextResponse.json({ ok: true, text: result.text });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502 },
    );
  }
}
