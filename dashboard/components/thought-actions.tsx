"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function ThoughtActions(
  { thoughtId, initialContent }: { thoughtId: string; initialContent: string },
) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(initialContent);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [undoToken, setUndoToken] = useState<string | null>(null);

  function save() {
    setError(null);
    startTransition(async () => {
      const resp = await fetch(`/api/thoughts/${thoughtId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, reason: "dashboard-edit" }),
      });
      if (!resp.ok) {
        setError(`Save failed: ${resp.status}`);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function softDelete() {
    if (!confirm("Forget this thought? You'll have a few seconds to undo.")) return;
    setError(null);
    startTransition(async () => {
      const resp = await fetch(`/api/thoughts/${thoughtId}`, {
        method: "DELETE",
      });
      if (!resp.ok) {
        setError(`Forget failed: ${resp.status}`);
        return;
      }
      // We don't have a true undo endpoint yet; offer "Recapture content"
      // by storing the original content client-side as the undo token.
      setUndoToken(initialContent);
      // Optimistic — go home so list refreshes without the row.
      setTimeout(() => {
        if (undoToken === null) router.push("/");
      }, 8000);
    });
  }

  async function undo() {
    if (!undoToken) return;
    startTransition(async () => {
      const resp = await fetch("/api/thoughts/recapture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: undoToken }),
      });
      if (!resp.ok) {
        setError(`Undo failed: ${resp.status}`);
        return;
      }
      setUndoToken(null);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <div className="card p-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={Math.min(20, Math.max(4, content.split("\n").length + 1))}
          className="w-full"
          style={{
            background: "var(--color-bg)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
            borderRadius: "0.4rem",
            padding: "0.5rem 0.6rem",
            fontFamily: "inherit",
            fontSize: "0.95rem",
            lineHeight: 1.5,
            resize: "vertical",
          }}
        />
        <div className="mt-3 flex gap-2">
          <button onClick={save} disabled={pending} className="btn btn-primary">
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => {
              setContent(initialContent);
              setEditing(false);
            }}
            disabled={pending}
            className="btn"
          >
            Cancel
          </button>
          {error ? <span className="text-sm" style={{ color: "#f7768e" }}>{error}</span> : null}
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--color-text-dim)" }}>
          Saving re-embeds the thought and re-runs entity extraction.
        </p>
      </div>
    );
  }

  return (
    <>
      <div
        className="card p-4 whitespace-pre-wrap"
        style={{ lineHeight: 1.55 }}
      >
        {content}
      </div>
      <div className="mt-3 flex gap-2 items-center">
        <button onClick={() => setEditing(true)} className="btn">Edit</button>
        <button onClick={softDelete} className="btn btn-danger" disabled={pending}>
          Forget
        </button>
        {error ? <span className="text-sm ml-2" style={{ color: "#f7768e" }}>{error}</span> : null}
        {undoToken ? (
          <span className="ml-auto card px-3 py-2 text-sm">
            Forgotten. <button onClick={undo} className="btn btn-primary ml-2" disabled={pending}>Undo</button>
          </span>
        ) : null}
      </div>
    </>
  );
}
