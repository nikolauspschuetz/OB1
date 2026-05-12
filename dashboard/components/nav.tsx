import Link from "next/link";

export function Nav() {
  return (
    <nav style={{ borderBottom: "1px solid var(--color-border)" }}>
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-4 text-sm">
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
        <form action="/api/logout" method="post" className="inline">
          <button type="submit" className="btn">Sign out</button>
        </form>
      </div>
    </nav>
  );
}
