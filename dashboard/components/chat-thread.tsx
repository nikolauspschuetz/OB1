"use client";
import { useEffect, useRef, useState } from "react";
import { CitedMarkdown } from "./markdown";

interface Msg {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  citations: string[];
  retrieval: Array<{ id: string; similarity: number; content?: string }>;
  model: string | null;
  created_at: string;
}

export function ChatThread(
  { chatId, initialMessages }: { chatId: number; initialMessages: Msg[] },
) {
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sending]);

  async function send() {
    const content = input.trim();
    if (!content || sending) return;
    setError(null);
    setSending(true);
    // Optimistic: append the user message immediately.
    const userMsg: Msg = {
      id: Math.random(),
      role: "user",
      content,
      citations: [],
      retrieval: [],
      model: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    try {
      const resp = await fetch(`/api/chat/${chatId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${resp.status}: ${errBody.slice(0, 200)}`);
      }
      const data = (await resp.json()) as {
        answer: string;
        citations: string[];
        retrieved: Array<{ id: string; content: string; similarity: number }>;
        model?: string;
      };
      const assistantMsg: Msg = {
        id: Math.random(),
        role: "assistant",
        content: data.answer,
        citations: data.citations,
        retrieval: data.retrieved.map((r) => ({
          id: r.id,
          similarity: r.similarity,
          content: r.content.slice(0, 400),
        })),
        model: data.model ?? null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      setError((e as Error).message);
      // Roll back optimistic user message so the user can edit + retry.
      setMessages((prev) => prev.filter((m) => m !== userMsg));
      setInput(content);
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div>
      <div className="space-y-3">
        {messages.length === 0 ? (
          <p style={{ color: "var(--color-text-dim)", fontSize: "0.9rem" }}>
            Ask anything. The response will cite captured thoughts inline using
            <code> [#xxxxxxxx]</code> — hover to preview.
          </p>
        ) : null}

        {messages.map((m) => (
          <div
            key={m.id}
            className="card"
            style={{
              padding: "0.8rem 1rem",
              borderLeft: `3px solid ${m.role === "assistant" ? "var(--color-accent)" : "var(--color-border)"}`,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "baseline",
                fontSize: "0.7rem",
                color: "var(--color-text-dim)",
                marginBottom: "0.3rem",
              }}
            >
              <span>{m.role}</span>
              {m.model ? <span>· {m.model}</span> : null}
              {m.retrieval.length ? <span>· {m.retrieval.length} retrieved</span> : null}
              <span style={{ marginLeft: "auto" }}>{new Date(m.created_at).toLocaleTimeString()}</span>
            </div>
            {m.role === "assistant" ? (
              <CitedMarkdown source={m.content} />
            ) : (
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, fontSize: "0.95rem" }}>
                {m.content}
              </div>
            )}
            {m.role === "assistant" && m.retrieval.length ? (
              <details style={{ marginTop: "0.6rem" }}>
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: "0.7rem",
                    color: "var(--color-text-dim)",
                  }}
                >
                  Retrieved passages ({m.retrieval.length})
                </summary>
                <ul style={{ listStyle: "none", paddingLeft: 0, marginTop: "0.4rem" }}>
                  {m.retrieval.map((r) => (
                    <li
                      key={r.id}
                      style={{
                        borderTop: "1px solid var(--color-border)",
                        padding: "0.4rem 0",
                        fontSize: "0.75rem",
                      }}
                    >
                      <div style={{ color: "var(--color-text-dim)" }}>
                        sim {r.similarity.toFixed(3)} · <a
                          href={`/thoughts/${r.id}`}
                          style={{ color: "var(--color-accent)" }}
                        >{r.id.slice(0, 8)}</a>
                      </div>
                      {r.content ? (
                        <div style={{ marginTop: "0.2rem", color: "var(--color-text)" }}>
                          {r.content}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ))}
        {sending ? (
          <div
            className="card"
            style={{
              padding: "0.8rem 1rem",
              borderLeft: "3px solid var(--color-accent)",
              opacity: 0.7,
            }}
          >
            <div style={{ fontSize: "0.75rem", color: "var(--color-text-dim)" }}>
              thinking… (retrieving + generating)
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <div
        className="card"
        style={{
          position: "sticky",
          bottom: "1rem",
          marginTop: "1.5rem",
          padding: "0.6rem",
        }}
      >
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={Math.min(6, Math.max(2, input.split("\n").length + 1))}
          placeholder="Ask your brain… (Enter to send, Shift+Enter for newline)"
          disabled={sending}
          style={{
            width: "100%",
            background: "var(--color-bg)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
            borderRadius: "0.4rem",
            padding: "0.5rem 0.6rem",
            fontFamily: "inherit",
            fontSize: "0.95rem",
            lineHeight: 1.5,
            resize: "none",
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="btn btn-primary"
          >
            {sending ? "Sending…" : "Send ↵"}
          </button>
          {error ? <span style={{ color: "#f7768e", fontSize: "0.8rem" }}>{error}</span> : null}
          <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--color-text-dim)" }}>
            ⏎ send · ⇧⏎ newline
          </span>
        </div>
      </div>
    </div>
  );
}
