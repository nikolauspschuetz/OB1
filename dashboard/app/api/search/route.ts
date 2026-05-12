import { NextResponse } from "next/server";
import { embed, synthesize } from "../../../lib/mcp";
import { vectorSearch } from "../../../lib/queries";

export async function POST(req: Request) {
  // Auth is enforced by middleware; we still keep this short.
  const body = (await req.json()) as { query?: string; synthesize?: boolean };
  const query = (body.query ?? "").trim();
  if (!query) return NextResponse.json({ hits: [] });

  const wantSynth = body.synthesize !== false; // default on
  try {
    const v = await embed(query);
    const hits = await vectorSearch(v, 0.2, 8);
    let answer: string | undefined;
    if (wantSynth && hits.length) {
      try {
        const syn = await synthesize(
          query,
          hits.slice(0, 5).map((h) => ({ id: h.id, content: h.content })),
        );
        answer = syn.answer;
      } catch {
        /* synthesis is best-effort */
      }
    }
    return NextResponse.json({ hits, answer });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, hits: [] },
      { status: 502 },
    );
  }
}
