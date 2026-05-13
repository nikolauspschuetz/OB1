import Link from "next/link";
import { env } from "../lib/env";

// Stable color per profile so the user gets visual continuity in the
// browser tab and in the corner badge across sessions.
function colorFor(name: string): string {
  // FNV-1a hash → hue. Cheap, deterministic, no deps.
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 70% 55%)`;
}

export function Nav() {
  const current = env.OB1_PROFILE;
  const peers = env.OB1_PEER_PROFILES.filter((p) => p.name !== current);
  return (
    <nav style={{ borderBottom: "1px solid var(--color-border)" }}>
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-4 text-sm">
        <span
          aria-label={`active profile: ${current}`}
          title={`active profile: ${current}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            padding: "0.15rem 0.55rem",
            borderRadius: "0.35rem",
            border: `1px solid ${colorFor(current)}`,
            color: colorFor(current),
            fontWeight: 600,
            fontSize: "0.78rem",
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
        </span>
        <Link href="/" className="font-semibold no-underline" style={{ color: "var(--color-text)" }}>
          Open Brain
        </Link>
        <span style={{ color: "var(--color-text-dim)" }}>·</span>
        <Link href="/" className="no-underline" style={{ color: "var(--color-text-dim)" }}>Recent</Link>
        <Link href="/entities" className="no-underline" style={{ color: "var(--color-text-dim)" }}>Entities</Link>
        <Link href="/wiki" className="no-underline" style={{ color: "var(--color-text-dim)" }}>Wiki</Link>
        <Link href="/queue" className="no-underline" style={{ color: "var(--color-text-dim)" }}>Queue</Link>
        <Link href="/health" className="no-underline" style={{ color: "var(--color-text-dim)" }}>Health</Link>
        <span className="ml-auto kbd">⌘K to search</span>
        {peers.length > 0 ? (
          <span style={{ display: "inline-flex", gap: "0.3rem", paddingRight: "0.5rem", borderRight: "1px solid var(--color-border)" }}>
            {peers.map((p) => (
              <a
                key={p.name}
                href={p.url}
                title={`switch to ${p.name} (${p.url})`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.15rem 0.45rem",
                  borderRadius: "0.3rem",
                  border: "1px solid var(--color-border)",
                  textDecoration: "none",
                  fontSize: "0.75rem",
                  color: "var(--color-text-dim)",
                }}
              >
                <span
                  style={{
                    width: "0.5rem",
                    height: "0.5rem",
                    borderRadius: "50%",
                    background: colorFor(p.name),
                  }}
                />
                {p.name}
              </a>
            ))}
          </span>
        ) : null}
        <form action="/api/logout" method="post" className="inline">
          <button type="submit" className="btn">Sign out</button>
        </form>
      </div>
    </nav>
  );
}
