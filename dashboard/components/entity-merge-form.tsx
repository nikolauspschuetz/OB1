"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function EntityMergeForm({ entityId }: { entityId: number }) {
  const router = useRouter();
  const [targetId, setTargetId] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function merge() {
    setError(null);
    setResult(null);
    const target = parseInt(targetId.trim(), 10);
    if (!Number.isFinite(target) || target <= 0) {
      setError("Enter the survivor entity ID (integer)");
      return;
    }
    if (target === entityId) {
      setError("Survivor must differ from this entity");
      return;
    }
    if (!confirm(`Merge entity #${entityId} INTO entity #${target}? This collapses thought_entities and edges and is logged. The merged entity is deleted.`)) return;
    start(async () => {
      const resp = await fetch("/api/entities/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ survivor_id: target, loser_id: entityId }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        setError(`Merge failed: ${resp.status} ${body.slice(0, 160)}`);
        return;
      }
      setResult(`Merged into #${target}. Redirecting…`);
      setTimeout(() => router.push(`/entities/${target}`), 700);
    });
  }

  return (
    <div className="card p-3">
      <p style={{ fontSize: "0.8rem", color: "var(--color-text-dim)", marginBottom: "0.4rem" }}>
        Merges <code>#{entityId}</code> as the LOSER into the survivor you specify. All links repoint, edges collapse, an audit row is written.
      </p>
      <div className="flex gap-2">
        <input
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="survivor entity id"
          className="card px-2 py-1 flex-1"
          style={{ background: "var(--color-bg)", fontSize: "0.85rem" }}
        />
        <button onClick={merge} disabled={pending} className="btn btn-danger">
          {pending ? "Merging…" : "Merge"}
        </button>
      </div>
      {error ? <p style={{ color: "#f7768e", fontSize: "0.75rem", marginTop: "0.4rem" }}>{error}</p> : null}
      {result ? <p style={{ color: "var(--color-accent)", fontSize: "0.75rem", marginTop: "0.4rem" }}>{result}</p> : null}
    </div>
  );
}
