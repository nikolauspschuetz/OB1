"use client";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";

// Citation hover-card: renders [#a1b2c3d4] as a clickable badge with a
// preview tooltip. The preview is loaded lazily on hover via /api/cite.

const CITE_RE = /\[#([0-9a-f]{8})\]/g;

interface CitedTextProps {
  text: string;
}

function CitedText({ text }: CitedTextProps) {
  const parts: Array<{ kind: "text" | "cite"; value: string }> = [];
  let last = 0;
  for (const m of text.matchAll(CITE_RE)) {
    if (m.index! > last) parts.push({ kind: "text", value: text.slice(last, m.index) });
    parts.push({ kind: "cite", value: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text"
          ? <span key={i}>{p.value}</span>
          : <Citation key={i} short={p.value} />
      )}
    </>
  );
}

function Citation({ short }: { short: string }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ id: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (preview || error) return;
    try {
      const resp = await fetch(`/api/cite?short=${short}`);
      if (!resp.ok) {
        setError(`${resp.status}`);
        return;
      }
      const json = await resp.json() as { id: string; content: string };
      setPreview(json);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onMouseEnter={() => { setOpen(true); load(); }}
        onMouseLeave={() => setOpen(false)}
        onClick={async () => {
          if (preview) window.location.href = `/thoughts/${preview.id}`;
          else { await load(); }
        }}
        className="kbd"
        style={{ cursor: "pointer", marginLeft: 1, marginRight: 1 }}
      >
        #{short}
      </button>
      {open ? (
        <span
          className="card"
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            zIndex: 30,
            width: "min(420px, 80vw)",
            padding: "0.5rem 0.7rem",
            fontSize: "0.8rem",
            marginBottom: "0.3rem",
            whiteSpace: "normal",
            color: "var(--color-text)",
          }}
        >
          {error ? <span style={{ color: "#f7768e" }}>preview failed: {error}</span> : null}
          {preview ? (
            <>
              <span style={{ color: "var(--color-text-dim)", fontSize: "0.7rem" }}>{preview.id}</span>
              <br />
              {preview.content.slice(0, 320)}
              {preview.content.length > 320 ? "…" : ""}
            </>
          ) : null}
          {!preview && !error ? <span style={{ color: "var(--color-text-dim)" }}>loading…</span> : null}
        </span>
      ) : null}
    </span>
  );
}

export function CitedMarkdown({ source }: { source: string }) {
  return (
    <div className="prose-ob1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Wrap any text node with our citation parser
          p: ({ children }) => <p>{wrap(children)}</p>,
          li: ({ children }) => <li>{wrap(children)}</li>,
          td: ({ children }) => <td>{wrap(children)}</td>,
          a: ({ href, children }) => href?.startsWith("/")
            ? <Link href={href}>{children}</Link>
            : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

// Recursively replace string children with CitedText to expand [#xxxxxxxx]
// markers anywhere they appear.
function wrap(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") return <CitedText text={children} />;
  if (Array.isArray(children)) return children.map((c, i) => <span key={i}>{wrap(c)}</span>);
  return children;
}
