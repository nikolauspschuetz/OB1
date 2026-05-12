import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "../../../lib/auth";
import {
  getEntity,
  getEntityEdges,
  getEntityThoughts,
} from "../../../lib/queries";
import { sql } from "../../../lib/db";
import { ThoughtCard } from "../../../components/thought-card";
import { EntityPinToggle } from "../../../components/entity-pin-toggle";
import { EntityMergeForm } from "../../../components/entity-merge-form";

export const dynamic = "force-dynamic";

export default async function EntityDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const entityId = parseInt(id, 10);
  if (!Number.isFinite(entityId) || entityId <= 0) notFound();

  const ent = await getEntity(entityId);
  if (!ent) notFound();

  const [edges, thoughts, wiki] = await Promise.all([
    getEntityEdges(entityId),
    getEntityThoughts(entityId, 30),
    sql<Array<{ slug: string; title: string }>>`
      SELECT slug, title FROM wiki_pages WHERE entity_id = ${entityId}::bigint LIMIT 1
    `,
  ]);

  return (
    <>
      <div className="mb-4 text-sm" style={{ color: "var(--color-text-dim)" }}>
        <Link href="/entities" className="no-underline">← Entities</Link>
      </div>

      <header className="mb-4 flex items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold">{ent.canonical_name}</h1>
          <div className="text-sm" style={{ color: "var(--color-text-dim)" }}>
            {ent.entity_type} · seen since {new Date(ent.first_seen_at).toISOString().slice(0, 10)} · {ent.thought_count} thoughts
          </div>
          {Array.isArray(ent.aliases) && ent.aliases.length ? (
            <div className="mt-1 text-xs" style={{ color: "var(--color-text-dim)" }}>
              aliases: {ent.aliases.join(", ")}
            </div>
          ) : null}
        </div>
        <div className="ml-auto flex gap-2">
          {wiki[0] ? (
            <Link href={`/wiki/${wiki[0].slug}`} className="btn no-underline">Wiki</Link>
          ) : null}
          <EntityPinToggle entityId={entityId} pinned={ent.pinned} />
        </div>
      </header>

      <section className="mb-6">
        <h2 className="text-sm font-semibold mb-2">Edges ({edges.length})</h2>
        {edges.length === 0 ? (
          <p style={{ color: "var(--color-text-dim)", fontSize: "0.85rem" }}>
            No edges yet. Edges accumulate as the worker links co-occurrences.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {edges.map((ed) => {
              const isOutgoing = ed.from_entity_id === entityId;
              const other = isOutgoing
                ? { id: ed.to_entity_id, name: ed.to_name, type: ed.to_type }
                : { id: ed.from_entity_id, name: ed.from_name, type: ed.from_type };
              const arrow = isOutgoing ? "→" : "←";
              return (
                <li key={ed.id}>
                  <span className="kbd">{ed.relation}</span>{" "}
                  <span style={{ color: "var(--color-text-dim)" }}>{arrow}</span>{" "}
                  <Link href={`/entities/${other.id}`} className="no-underline">{other.name}</Link>
                  <span style={{ color: "var(--color-text-dim)", marginLeft: "0.5rem", fontSize: "0.75rem" }}>
                    ({other.type} · support {ed.support_count}
                    {ed.confidence ? ` · conf ${parseFloat(ed.confidence).toFixed(2)}` : ""})
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold mb-2">Merge into another entity</h2>
        <EntityMergeForm entityId={entityId} />
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">Linked thoughts</h2>
        <div className="space-y-3">
          {thoughts.map((t) => <ThoughtCard key={t.id} t={t} />)}
          {thoughts.length === 0 ? (
            <p style={{ color: "var(--color-text-dim)", fontSize: "0.85rem" }}>
              No thoughts link to this entity yet.
            </p>
          ) : null}
        </div>
      </section>
    </>
  );
}
