import Link from "next/link";
import type { ThoughtRow } from "../lib/queries";

function relativeTime(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const diffS = Math.floor((now - t) / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  const m = Math.floor(diffS / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function topicsOf(meta: Record<string, unknown>): string[] {
  const t = meta.topics;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

export function ThoughtCard({ t }: { t: ThoughtRow }) {
  const topics = topicsOf(t.metadata);
  const source = typeof t.metadata.source === "string"
    ? (t.metadata.source as string)
    : null;
  return (
    <Link
      href={`/thoughts/${t.id}`}
      className="block card p-4 no-underline"
      style={{ color: "var(--color-text)" }}
    >
      <div className="flex items-center gap-2 mb-2 text-xs" style={{ color: "var(--color-text-dim)" }}>
        <span>{relativeTime(t.created_at)}</span>
        {t.type ? <span>· {t.type}</span> : null}
        {source ? <span>· {source}</span> : null}
        <span className="ml-auto" style={{ color: "var(--color-text-dim)" }}>
          {t.id.slice(0, 8)}
        </span>
      </div>
      <div
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 4,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {t.content}
      </div>
      {topics.length ? (
        <div className="mt-2 flex gap-1 flex-wrap">
          {topics.slice(0, 6).map((tp) => (
            <span key={tp} className="kbd">{tp}</span>
          ))}
        </div>
      ) : null}
    </Link>
  );
}
