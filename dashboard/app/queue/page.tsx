import Link from "next/link";
import { requireSession } from "../../lib/auth";
import {
  getEntityCount,
  getQueueStats,
  getRecentQueueFailures,
  getThoughtCount,
  getWikiCount,
} from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  await requireSession();
  const [stats, failures, thoughts, entities, wikis] = await Promise.all([
    getQueueStats(),
    getRecentQueueFailures(15),
    getThoughtCount(),
    getEntityCount(),
    getWikiCount(),
  ]);

  return (
    <>
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Worker queue</h1>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {(["pending", "processing", "complete", "failed", "skipped"] as const).map((k) => (
          <div key={k} className="card p-3">
            <div className="text-xs" style={{ color: "var(--color-text-dim)" }}>{k}</div>
            <div className="text-2xl font-semibold">{stats[k]}</div>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-3 gap-3 mb-6">
        <div className="card p-3">
          <div className="text-xs" style={{ color: "var(--color-text-dim)" }}>thoughts</div>
          <div className="text-2xl font-semibold">{thoughts}</div>
        </div>
        <div className="card p-3">
          <div className="text-xs" style={{ color: "var(--color-text-dim)" }}>entities</div>
          <div className="text-2xl font-semibold">{entities}</div>
        </div>
        <div className="card p-3">
          <div className="text-xs" style={{ color: "var(--color-text-dim)" }}>wikis</div>
          <div className="text-2xl font-semibold">{wikis}</div>
        </div>
      </section>

      {failures.length ? (
        <section>
          <h2 className="text-sm font-semibold mb-2">Recent failures</h2>
          <ul className="space-y-2 text-sm">
            {failures.map((f) => (
              <li key={f.thought_id} className="card p-3">
                <div className="text-xs" style={{ color: "var(--color-text-dim)" }}>
                  {new Date(f.queued_at).toLocaleString()} · attempts {f.attempt_count}
                </div>
                <Link href={`/thoughts/${f.thought_id}`} className="no-underline">
                  {f.thought_id}
                </Link>
                {f.last_error ? (
                  <pre style={{ background: "var(--color-bg)", padding: "0.4em 0.6em", borderRadius: "0.3em", overflowX: "auto", marginTop: "0.4rem", fontSize: "0.75rem" }}>
                    {f.last_error}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-sm" style={{ color: "var(--color-text-dim)" }}>
          No failures. Bring the worker up with <code>WORKER=1 make up</code> if you don&apos;t see processing progress.
        </p>
      )}
    </>
  );
}
