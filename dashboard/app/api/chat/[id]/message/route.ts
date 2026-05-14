import { NextResponse } from "next/server";
import { getSession } from "../../../../../lib/auth";
import {
  appendMessage,
  citationShorts,
  deriveTitle,
  getChat,
  getMessages,
  renameChat,
} from "../../../../../lib/chat";
import { chatTurn } from "../../../../../lib/mcp";
import { sql } from "../../../../../lib/db";

// POST /api/chat/[id]/message — body { content }. Server:
//   1. Persist the user turn.
//   2. Build history from DB (so multiple browser tabs stay in sync).
//   3. Call /dashboard-api/chat on the MCP server (embed + retrieve + LLM).
//   4. Resolve [#xxxxxxxx] citations to full UUIDs.
//   5. Persist the assistant turn. Auto-title the chat if untitled.
//   6. Return the assistant message for the client to render.
//
// Not streamed yet — Phase 2 if turns get long.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const chatId = parseInt(id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return NextResponse.json({ error: "bad chat id" }, { status: 400 });
  }

  let body: { content?: string };
  try {
    body = (await req.json()) as { content?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const content = (body.content ?? "").trim();
  if (!content) return NextResponse.json({ error: "content required" }, { status: 400 });

  const chat = await getChat(chatId);
  if (!chat) return NextResponse.json({ error: "chat not found" }, { status: 404 });

  // 1. user turn
  await appendMessage({ chatId, role: "user", content });

  // 2. full history for context
  const messages = await getMessages(chatId);
  const history = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // 3. RAG turn
  let result;
  try {
    result = await chatTurn({ history });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502 },
    );
  }

  // 4. resolve [#shortid] → full UUIDs against the retrieved set first,
  //    then fall back to a prefix DB lookup for anything the model
  //    invented from memory.
  const shorts = citationShorts(result.answer);
  const retrievedIndex = new Map(
    result.retrieved.map((r) => [r.id.slice(0, 8), r.id]),
  );
  const citations: string[] = [];
  const unresolved: string[] = [];
  for (const s of shorts) {
    const hit = retrievedIndex.get(s);
    if (hit) citations.push(hit);
    else unresolved.push(s);
  }
  if (unresolved.length) {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id::text FROM thoughts
       WHERE LEFT(id::text, 8) = ANY(${unresolved}::text[])
       LIMIT 50
    `;
    for (const r of rows) {
      if (!citations.includes(r.id)) citations.push(r.id);
    }
  }

  // 5. persist assistant turn
  await appendMessage({
    chatId,
    role: "assistant",
    content: result.answer,
    citations,
    retrieval: result.retrieved.map((r) => ({
      id: r.id,
      similarity: r.similarity,
      content: r.content.slice(0, 400),
    })),
    model: result.model ?? null,
  });

  // Auto-title from first user turn if chat is untitled.
  if (!chat.title && messages.filter((m) => m.role === "user").length === 0) {
    await renameChat(chatId, deriveTitle(content));
  }

  return NextResponse.json({
    ok: true,
    answer: result.answer,
    citations,
    retrieved: result.retrieved,
    model: result.model,
  });
}
