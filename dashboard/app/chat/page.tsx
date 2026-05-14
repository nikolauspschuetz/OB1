import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { listChats } from "../../lib/chat";
import { NewChatButton } from "../../components/new-chat-button";

export const dynamic = "force-dynamic";

export default async function ChatList() {
  await requireSession();
  const chats = await listChats({ limit: 100 });

  function relativeTime(iso: string): string {
    const t = new Date(iso).getTime();
    const diffS = Math.floor((Date.now() - t) / 1000);
    if (diffS < 60) return "just now";
    const m = Math.floor(diffS / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d < 30 ? `${d}d ago` : new Date(iso).toISOString().slice(0, 10);
  }

  return (
    <>
      <header className="mb-4 flex items-center">
        <h1 className="text-lg font-semibold">Chat with your brain</h1>
        <span className="text-sm ml-2" style={{ color: "var(--color-text-dim)" }}>
          {chats.length} conversation{chats.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto"><NewChatButton /></span>
      </header>

      <p className="text-sm mb-4" style={{ color: "var(--color-text-dim)" }}>
        Multi-turn RAG conversation grounded in this profile&apos;s thoughts. Each
        user turn embeds → retrieves top-K relevant thoughts → calls the chat
        model with them as context. Citations expand inline.
      </p>

      <div className="space-y-2">
        {chats.length === 0 ? (
          <p style={{ color: "var(--color-text-dim)" }}>
            No conversations yet. Click <strong>New chat</strong> above.
          </p>
        ) : (
          chats.map((c) => (
            <Link
              key={c.id}
              href={`/chat/${c.id}`}
              className="block card p-3 no-underline"
              style={{ color: "var(--color-text)" }}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.title ?? "(untitled)"}</span>
                <span className="ml-auto text-xs" style={{ color: "var(--color-text-dim)" }}>
                  {c.message_count} message{c.message_count === 1 ? "" : "s"} · {relativeTime(c.updated_at)}
                </span>
              </div>
            </Link>
          ))
        )}
      </div>
    </>
  );
}
