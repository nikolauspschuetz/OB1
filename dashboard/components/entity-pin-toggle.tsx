"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function EntityPinToggle(
  { entityId, pinned }: { entityId: number; pinned: boolean },
) {
  const router = useRouter();
  const [state, setState] = useState(pinned);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    const next = !state;
    start(async () => {
      const resp = await fetch(`/api/entities/${entityId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: next }),
      });
      if (!resp.ok) {
        setError("pin failed");
        return;
      }
      setState(next);
      router.refresh();
    });
  }

  return (
    <>
      <button onClick={toggle} disabled={pending} className="btn">
        {state ? "📌 Unpin" : "Pin"}
      </button>
      {error ? <span style={{ color: "#f7768e", fontSize: "0.75rem" }}>{error}</span> : null}
    </>
  );
}
