import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { listWikis } from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function WikiIndex() {
  await requireSession();
  const wikis = await listWikis(200);
  return (
    <>
      <header className="mb-4 flex items-center">
        <h1 className="text-lg font-semibold">Wiki</h1>
        <span className="text-sm ml-2" style={{ color: "var(--color-text-dim)" }}>
          {wikis.length} pages
        </span>
      </header>
      <div className="space-y-2">
        {wikis.map((w) => (
          <Link
            key={w.id}
            href={`/wiki/${w.slug}`}
            className="block card p-3 no-underline"
            style={{ color: "var(--color-text)" }}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{w.title}</span>
              <span className="kbd">{w.type}</span>
              {w.manually_edited ? <span className="kbd">✎ edited</span> : null}
              <span className="ml-auto text-xs" style={{ color: "var(--color-text-dim)" }}>
                {w.thought_count} thoughts · regen {new Date(w.generated_at).toISOString().slice(0, 10)}
              </span>
            </div>
          </Link>
        ))}
        {wikis.length === 0 ? (
          <p style={{ color: "var(--color-text-dim)" }}>
            No wikis generated yet. The worker regenerates entities with ≥{" "}
            <code>MIN_LINKED_FOR_WIKI</code> linked thoughts after queue drain.
          </p>
        ) : null}
      </div>
    </>
  );
}
