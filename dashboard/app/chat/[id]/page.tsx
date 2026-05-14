import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "../../../lib/auth";
import { getChat, getMessages } from "../../../lib/chat";
import { ChatThread } from "../../../components/chat-thread";

export const dynamic = "force-dynamic";

export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const chatId = parseInt(id, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) notFound();

  const chat = await getChat(chatId);
  if (!chat) notFound();

  const messages = await getMessages(chatId);

  return (
    <>
      <div className="mb-3 text-sm flex items-center gap-2" style={{ color: "var(--color-text-dim)" }}>
        <Link href="/chat" className="no-underline">← Chats</Link>
        <span>·</span>
        <span>{chat.title ?? "(untitled)"}</span>
        <span className="ml-auto" style={{ fontSize: "0.7rem" }}>
          {new Date(chat.created_at).toISOString().slice(0, 16).replace("T", " ")}
        </span>
      </div>

      <ChatThread
        chatId={chatId}
        initialMessages={messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: m.citations,
          retrieval: m.retrieval,
          model: m.model,
          created_at: m.created_at,
        }))}
      />
    </>
  );
}
