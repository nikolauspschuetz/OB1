import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "../../../lib/auth";
import {
  getAttribution,
  getThought,
  getThoughtEntities,
} from "../../../lib/queries";
import { ThoughtActions } from "../../../components/thought-actions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ThoughtDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const t = await getThought(id);
  if (!t) notFound();

  const [entities, attribution] = await Promise.all([
    getThoughtEntities(id),
    getAttribution(id),
  ]);

  const topics = Array.isArray(t.metadata.topics)
    ? (t.metadata.topics.filter((x): x is string => typeof x === "string"))
    : [];

  return (
    <>
      <div className="mb-4 text-sm" style={{ color: "var(--color-text-dim)" }}>
        <Link href="/" className="no-underline">← Recent</Link>
      </div>

      <header className="mb-4">
        <div className="text-xs mb-1" style={{ color: "var(--color-text-dim)" }}>
          {new Date(t.created_at).toLocaleString()} · {t.id}
        </div>
        <div className="flex gap-2 flex-wrap text-sm" style={{ color: "var(--color-text-dim)" }}>
          {t.type ? <span className="kbd">{t.type}</span> : null}
          {typeof t.metadata.source === "string"
            ? <span className="kbd">{t.metadata.source as string}</span>
            : null}
          {topics.map((tp) => <span key={tp} className="kbd">{tp}</span>)}
        </div>
      </header>

      <ThoughtActions thoughtId={t.id} initialContent={t.content} />

      {entities.length ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold mb-2">Linked entities</h2>
          <div className="flex flex-wrap gap-2">
            {entities.map((e) => (
              <Link
                key={e.entity_id}
                href={`/entities/${e.entity_id}`}
                className="kbd no-underline"
              >
                {e.canonical_name} · {e.entity_type}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {attribution.length ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold mb-2">History</h2>
          <ol className="space-y-1 text-sm">
            {attribution.map((a) => (
              <li key={a.id} style={{ color: "var(--color-text-dim)" }}>
                <span className="kbd">{a.action}</span>
                {" "}
                <span>{new Date(a.created_at).toLocaleString()}</span>
                {a.actor ? <span> · {a.actor}</span> : null}
                {a.old_value || a.new_value || Object.keys(a.metadata ?? {}).length ? (
                  <pre className="mt-1 text-xs" style={{ background: "var(--color-bg-elev)", padding: "0.4em 0.6em", borderRadius: "0.3em", overflowX: "auto" }}>
                    {JSON.stringify({ old_value: a.old_value, new_value: a.new_value, metadata: a.metadata }, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <details className="mt-6">
        <summary className="text-sm cursor-pointer" style={{ color: "var(--color-text-dim)" }}>
          Raw metadata
        </summary>
        <pre className="mt-2 text-xs card p-3 overflow-x-auto">
{JSON.stringify(t.metadata, null, 2)}
        </pre>
      </details>
    </>
  );
}
