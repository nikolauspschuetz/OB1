import Link from "next/link";
import { requireSession } from "../lib/auth";
import { listThoughts } from "../lib/queries";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { ThoughtCard } from "../components/thought-card";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    type?: string;
    topic?: string;
    source?: string;
  }>;
}) {
  await requireSession();
  const params = await searchParams;
  const cursor = decodeCursor(params.cursor ?? null);
  const page = await listThoughts({
    limit: 20,
    cursor,
    type: params.type ?? null,
    topic: params.topic ?? null,
    source: params.source ?? null,
  });

  const clearAll = "/";
  const activeFilters = ["type", "topic", "source"]
    .map((k) => [k, (params as Record<string, string | undefined>)[k]])
    .filter(([, v]) => !!v) as Array<[string, string]>;

  return (
    <>
      <header className="flex items-center mb-4">
        <h1 className="text-lg font-semibold">Recent thoughts</h1>
        <span className="ml-2 text-sm" style={{ color: "var(--color-text-dim)" }}>
          {page.rows.length} on this page
        </span>
        {activeFilters.length ? (
          <Link href={clearAll} className="ml-auto kbd no-underline">clear filters</Link>
        ) : null}
      </header>

      {activeFilters.length ? (
        <div className="mb-3 flex gap-1 flex-wrap">
          {activeFilters.map(([k, v]) => (
            <span key={k} className="kbd">{k}: {v}</span>
          ))}
        </div>
      ) : null}

      <div className="space-y-3">
        {page.rows.length === 0 ? (
          <p style={{ color: "var(--color-text-dim)" }}>
            No thoughts yet. Capture some with <code>obctl capture &quot;...&quot;</code> or via MCP.
          </p>
        ) : (
          page.rows.map((t) => <ThoughtCard key={t.id} t={t} />)
        )}
      </div>

      {page.nextCursor ? (
        <div className="mt-6 text-center">
          <Link
            href={`/?${(() => {
              const u = new URLSearchParams();
              u.set("cursor", encodeCursor(page.nextCursor!));
              if (params.type) u.set("type", params.type);
              if (params.topic) u.set("topic", params.topic);
              if (params.source) u.set("source", params.source);
              return u.toString();
            })()}`}
            className="btn no-underline"
          >
            Older →
          </Link>
        </div>
      ) : null}

      <p className="mt-8 text-xs" style={{ color: "var(--color-text-dim)" }}>
        Tip: use Cmd+K for semantic search.
      </p>
    </>
  );
}
