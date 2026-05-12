"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function WikiNotesEditor(
  { slug, initialNotes }: { slug: string; initialNotes: string },
) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      const resp = await fetch(`/api/wiki/${encodeURIComponent(slug)}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!resp.ok) {
        setError(`save failed: ${resp.status}`);
        return;
      }
      setSaved(true);
      router.refresh();
      setTimeout(() => setSaved(false), 1500);
    });
  }

  return (
    <div className="card p-3">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={6}
        placeholder="Curator overrides, corrections, additional context the synthesizer should treat as authoritative…"
        className="w-full"
        style={{
          background: "var(--color-bg)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
          borderRadius: "0.4rem",
          padding: "0.5rem 0.6rem",
          fontFamily: "inherit",
          fontSize: "0.9rem",
          lineHeight: 1.5,
          resize: "vertical",
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={save} disabled={pending} className="btn btn-primary">
          {pending ? "Saving…" : "Save notes"}
        </button>
        {saved ? <span style={{ color: "var(--color-accent)", fontSize: "0.8rem" }}>saved</span> : null}
        {error ? <span style={{ color: "#f7768e", fontSize: "0.8rem" }}>{error}</span> : null}
      </div>
    </div>
  );
}
