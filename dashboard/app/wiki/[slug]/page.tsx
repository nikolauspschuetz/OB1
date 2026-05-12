import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "../../../lib/auth";
import { getWiki } from "../../../lib/queries";
import { CitedMarkdown } from "../../../components/markdown";
import { WikiNotesEditor } from "../../../components/wiki-notes-editor";

export const dynamic = "force-dynamic";

export default async function WikiPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireSession();
  const { slug } = await params;
  const w = await getWiki(slug);
  if (!w) notFound();

  return (
    <>
      <div className="mb-4 text-sm" style={{ color: "var(--color-text-dim)" }}>
        <Link href="/wiki" className="no-underline">← Wiki</Link>
        {w.entity_id ? <> · <Link href={`/entities/${w.entity_id}`} className="no-underline">entity #{w.entity_id}</Link></> : null}
      </div>

      <header className="mb-4">
        <h1 className="text-2xl font-semibold">{w.title}</h1>
        <div className="text-xs mt-1" style={{ color: "var(--color-text-dim)" }}>
          {w.type} · {w.thought_count} thoughts · regenerated {new Date(w.generated_at).toISOString().slice(0, 16).replace("T", " ")}
          {w.manually_edited ? " · manually edited" : ""}
        </div>
      </header>

      <article className="card p-5">
        <CitedMarkdown source={w.content} />
      </article>

      <section className="mt-6">
        <h2 className="text-sm font-semibold mb-2">Curator notes</h2>
        <p className="text-xs mb-2" style={{ color: "var(--color-text-dim)" }}>
          Notes survive regeneration and are folded back into the next synthesis prompt as authoritative input.
        </p>
        <WikiNotesEditor slug={w.slug} initialNotes={w.notes ?? ""} />
      </section>
    </>
  );
}
