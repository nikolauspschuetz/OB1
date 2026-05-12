import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { listEntities } from "../../lib/queries";

export const dynamic = "force-dynamic";

const TYPES = ["person", "project", "topic", "tool", "organization", "place"];

export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; pinned?: string; q?: string }>;
}) {
  await requireSession();
  const params = await searchParams;
  const type = params.type ?? null;
  const pinned = params.pinned === "1" ? true : params.pinned === "0" ? false : null;
  const q = params.q ?? null;

  const entities = await listEntities({ type, pinned, q, limit: 200 });

  function tabUrl(t: string | null) {
    const u = new URLSearchParams();
    if (t) u.set("type", t);
    if (pinned !== null) u.set("pinned", pinned ? "1" : "0");
    if (q) u.set("q", q);
    return `/entities?${u.toString()}`;
  }

  return (
    <>
      <header className="mb-4 flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-semibold">Entities</h1>
        <span className="text-sm" style={{ color: "var(--color-text-dim)" }}>
          {entities.length} shown
        </span>
        <form className="ml-auto" method="get">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="filter by name…"
            className="card px-2 py-1"
            style={{ background: "var(--color-bg)", fontSize: "0.85rem" }}
          />
        </form>
      </header>

      <div className="mb-3 flex gap-1 flex-wrap text-xs">
        <Link href={tabUrl(null)} className={"kbd no-underline " + (!type ? "border-accent" : "")}>all</Link>
        {TYPES.map((t) => (
          <Link
            key={t}
            href={tabUrl(t)}
            className="kbd no-underline"
            style={type === t ? { borderColor: "var(--color-accent)", color: "var(--color-accent)" } : {}}
          >
            {t}
          </Link>
        ))}
        <Link href="/entities?pinned=1" className="kbd no-underline ml-2">📌 pinned</Link>
      </div>

      <div className="card overflow-hidden">
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ background: "var(--color-bg-elev)" }}>
              <th style={{ padding: "0.5rem 0.8rem", textAlign: "left", borderBottom: "1px solid var(--color-border)" }}>Name</th>
              <th style={{ padding: "0.5rem 0.8rem", textAlign: "left", borderBottom: "1px solid var(--color-border)" }}>Type</th>
              <th style={{ padding: "0.5rem 0.8rem", textAlign: "right", borderBottom: "1px solid var(--color-border)" }}>Thoughts</th>
              <th style={{ padding: "0.5rem 0.8rem", textAlign: "left", borderBottom: "1px solid var(--color-border)" }}>Last seen</th>
              <th style={{ padding: "0.5rem 0.8rem", textAlign: "left", borderBottom: "1px solid var(--color-border)" }}>Pin</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((e) => (
              <tr key={e.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                <td style={{ padding: "0.4rem 0.8rem" }}>
                  <Link href={`/entities/${e.id}`} className="no-underline">{e.canonical_name}</Link>
                  {Array.isArray(e.aliases) && e.aliases.length ? (
                    <span style={{ marginLeft: "0.5rem", color: "var(--color-text-dim)", fontSize: "0.75rem" }}>
                      ({e.aliases.slice(0, 3).join(", ")})
                    </span>
                  ) : null}
                </td>
                <td style={{ padding: "0.4rem 0.8rem", color: "var(--color-text-dim)" }}>{e.entity_type}</td>
                <td style={{ padding: "0.4rem 0.8rem", textAlign: "right" }}>{e.thought_count}</td>
                <td style={{ padding: "0.4rem 0.8rem", color: "var(--color-text-dim)" }}>
                  {new Date(e.last_seen_at).toISOString().slice(0, 10)}
                </td>
                <td style={{ padding: "0.4rem 0.8rem" }}>{e.pinned ? "📌" : ""}</td>
              </tr>
            ))}
            {entities.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: "1rem", color: "var(--color-text-dim)" }}>No entities match.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
