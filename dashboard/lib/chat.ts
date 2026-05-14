import { sql } from "./db";

export interface ChatRow {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
  message_count: number;
}

export interface ChatMessageRow {
  id: number;
  chat_id: number;
  role: "user" | "assistant" | "system";
  content: string;
  citations: string[];                    // thought UUIDs the assistant cited
  retrieval: Array<{ id: string; similarity: number; content?: string }>;
  model: string | null;
  created_at: string;
}

export async function listChats(opts: {
  archived?: boolean;
  limit?: number;
} = {}): Promise<ChatRow[]> {
  const archived = opts.archived ?? false;
  const limit = Math.min(opts.limit ?? 50, 200);
  return await sql<ChatRow[]>`
    SELECT c.id::int AS id, c.title, c.created_at, c.updated_at, c.archived,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id)::int AS message_count
      FROM chats c
     WHERE c.archived = ${archived}
     ORDER BY c.updated_at DESC
     LIMIT ${limit}
  `;
}

export async function getChat(id: number): Promise<ChatRow | null> {
  const rows = await sql<ChatRow[]>`
    SELECT c.id::int AS id, c.title, c.created_at, c.updated_at, c.archived,
           (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id)::int AS message_count
      FROM chats c
     WHERE c.id = ${id}::bigint
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getMessages(chatId: number): Promise<ChatMessageRow[]> {
  return await sql<ChatMessageRow[]>`
    SELECT id::int AS id, chat_id::int AS chat_id, role, content,
           citations, retrieval, model, created_at
      FROM chat_messages
     WHERE chat_id = ${chatId}::bigint
     ORDER BY created_at ASC, id ASC
  `;
}

export async function createChat(title: string | null = null): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO chats (title) VALUES (${title})
    RETURNING id::int AS id
  `;
  return rows[0].id;
}

export async function appendMessage(args: {
  chatId: number;
  role: "user" | "assistant" | "system";
  content: string;
  citations?: string[];
  retrieval?: ChatMessageRow["retrieval"];
  model?: string | null;
}): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO chat_messages (chat_id, role, content, citations, retrieval, model)
    VALUES (
      ${args.chatId}::bigint,
      ${args.role},
      ${args.content},
      ${JSON.stringify(args.citations ?? [])}::jsonb,
      ${JSON.stringify(args.retrieval ?? [])}::jsonb,
      ${args.model ?? null}
    )
    RETURNING id::int AS id
  `;
  // Bump chat updated_at so it floats to the top of the list.
  await sql`UPDATE chats SET updated_at = now() WHERE id = ${args.chatId}::bigint`;
  return rows[0].id;
}

export async function renameChat(id: number, title: string): Promise<void> {
  await sql`UPDATE chats SET title = ${title}, updated_at = now() WHERE id = ${id}::bigint`;
}

export async function archiveChat(id: number): Promise<void> {
  await sql`UPDATE chats SET archived = true, updated_at = now() WHERE id = ${id}::bigint`;
}

/**
 * Auto-derive a title from the first user turn: first sentence or 80
 * chars, whichever shorter. Avoids leaving "(Untitled)" forever.
 */
export function deriveTitle(content: string): string {
  const first = content.trim().split(/[.\n!?]/, 1)[0] ?? content;
  return first.length > 80 ? first.slice(0, 80) + "…" : first;
}

// Parse [#xxxxxxxx] citation markers out of assistant content. Returns
// the unique 8-char hex prefixes.
export function citationShorts(content: string): string[] {
  const set = new Set<string>();
  for (const m of content.matchAll(/\[#([0-9a-f]{8})\]/g)) set.add(m[1]);
  return Array.from(set);
}
