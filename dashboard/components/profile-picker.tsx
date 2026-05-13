"use client";
import { useEffect, useRef, useState } from "react";

// Stable color per profile so the user gets visual continuity in the
// browser tab and in the corner badge across sessions.
function colorFor(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 70% 55%)`;
}

interface Peer {
  name: string;
  url: string;
}

export function ProfilePicker({ current, peers }: { current: string; peers: Peer[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Build full ordered list: current first, then peers alphabetically.
  const all = [{ name: current, url: null as string | null, active: true }]
    .concat(
      peers
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ name: p.name, url: p.url as string | null, active: false })),
    );

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`active profile: ${current}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4rem",
          padding: "0.2rem 0.6rem",
          borderRadius: "0.4rem",
          border: `1px solid ${colorFor(current)}`,
          background: "transparent",
          color: colorFor(current),
          fontWeight: 600,
          fontSize: "0.8rem",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: "0.55rem",
            height: "0.55rem",
            borderRadius: "50%",
            background: colorFor(current),
          }}
        />
        {current}
        <span style={{ opacity: 0.6, fontSize: "0.7rem", marginLeft: "0.1rem" }}>▾</span>
      </button>

      {open ? (
        <div
          role="listbox"
          className="card"
          style={{
            position: "absolute",
            top: "calc(100% + 0.35rem)",
            left: 0,
            zIndex: 40,
            minWidth: "14rem",
            padding: "0.3rem",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          <div
            style={{
              padding: "0.3rem 0.5rem",
              fontSize: "0.7rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--color-text-dim)",
            }}
          >
            Profiles
          </div>
          {all.map((p) => {
            const isActive = p.active;
            const content = (
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.4rem 0.5rem",
                  borderRadius: "0.3rem",
                  fontSize: "0.85rem",
                  color: "var(--color-text)",
                  background: isActive ? "var(--color-accent-soft)" : "transparent",
                  cursor: isActive ? "default" : "pointer",
                }}
              >
                <span
                  style={{
                    width: "0.6rem",
                    height: "0.6rem",
                    borderRadius: "50%",
                    background: colorFor(p.name),
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, fontWeight: isActive ? 600 : 400 }}>{p.name}</span>
                {isActive ? (
                  <span style={{ fontSize: "0.7rem", color: "var(--color-text-dim)" }}>
                    active
                  </span>
                ) : (
                  <span style={{ fontSize: "0.7rem", color: "var(--color-text-dim)" }}>
                    {p.url ? new URL(p.url).port : ""}
                  </span>
                )}
              </span>
            );
            if (isActive || !p.url) {
              return (
                <div key={p.name} role="option" aria-selected="true">
                  {content}
                </div>
              );
            }
            return (
              <a
                key={p.name}
                role="option"
                href={p.url}
                style={{ display: "block", textDecoration: "none" }}
                onMouseEnter={(e) => {
                  (e.currentTarget.firstElementChild as HTMLElement).style.background =
                    "var(--color-bg)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget.firstElementChild as HTMLElement).style.background =
                    "transparent";
                }}
              >
                {content}
              </a>
            );
          })}
          {peers.length === 0 ? (
            <div style={{ padding: "0.4rem 0.5rem", fontSize: "0.75rem", color: "var(--color-text-dim)" }}>
              No other profiles configured.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
