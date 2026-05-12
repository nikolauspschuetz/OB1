"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

interface Hit {
  id: string;
  content: string;
  similarity: number;
  created_at: string;
}

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQ("");
      setHits([]);
      setAnswer(null);
      setError(null);
    }
  }, [open]);

  const run = useCallback(async (query: string) => {
    if (!query.trim()) {
      setHits([]);
      setAnswer(null);
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const resp = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: ac.signal,
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`${resp.status}: ${body.slice(0, 160)}`);
      }
      const json = await resp.json() as {
        hits: Hit[];
        answer?: string;
      };
      setHits(json.hits ?? []);
      if (json.answer) setAnswer(json.answer);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => run(q), 250);
    return () => clearTimeout(t);
  }, [q, open, run]);

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 50,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "10vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: "min(720px, 90vw)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "0.6rem 0.8rem", borderBottom: "1px solid var(--color-border)" }}>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search thoughts…"
            style={{
              width: "100%",
              background: "transparent",
              color: "var(--color-text)",
              border: 0,
              outline: 0,
              fontSize: "1rem",
            }}
          />
        </div>
        <div style={{ overflowY: "auto" }}>
          {loading ? (
            <div style={{ padding: "0.8rem", color: "var(--color-text-dim)", fontSize: "0.85rem" }}>
              Searching…
            </div>
          ) : null}
          {error ? (
            <div style={{ padding: "0.8rem", color: "#f7768e", fontSize: "0.85rem" }}>
              {error}
            </div>
          ) : null}
          {answer ? (
            <div
              style={{
                padding: "0.8rem",
                borderBottom: "1px solid var(--color-border)",
                background: "var(--color-accent-soft)",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--color-text-dim)", marginBottom: "0.3rem" }}>
                synthesized answer
              </div>
              <div style={{ fontSize: "0.9rem", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {answer}
              </div>
            </div>
          ) : null}
          {hits.map((h) => (
            <Link
              key={h.id}
              href={`/thoughts/${h.id}`}
              onClick={() => setOpen(false)}
              className="no-underline"
              style={{
                display: "block",
                padding: "0.6rem 0.8rem",
                borderBottom: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--color-text-dim)", marginBottom: "0.2rem" }}>
                sim {h.similarity.toFixed(3)} · {new Date(h.created_at).toLocaleDateString()} · {h.id.slice(0, 8)}
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {h.content}
              </div>
            </Link>
          ))}
          {!loading && q && hits.length === 0 && !error ? (
            <div style={{ padding: "0.8rem", color: "var(--color-text-dim)", fontSize: "0.85rem" }}>
              No matches.
            </div>
          ) : null}
        </div>
        <div
          style={{
            padding: "0.4rem 0.8rem",
            borderTop: "1px solid var(--color-border)",
            color: "var(--color-text-dim)",
            fontSize: "0.7rem",
            display: "flex",
            gap: "0.8rem",
          }}
        >
          <span><span className="kbd">esc</span> close</span>
          <span><span className="kbd">⌘K</span> toggle</span>
          <span style={{ marginLeft: "auto" }}>semantic search · top {hits.length}</span>
        </div>
      </div>
    </div>
  );
}
