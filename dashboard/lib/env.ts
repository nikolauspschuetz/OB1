// Server-only env. Lazy validation — we don't throw at module-load time
// (Next.js does build-time page-data collection without env, which would
// otherwise blow up). Each accessor throws at first use if its value is
// missing or empty.

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get DB_HOST() { return opt("DB_HOST", "db"); },
  get DB_PORT() { return parseInt(opt("DB_PORT", "5432"), 10); },
  get DB_NAME() { return opt("DB_NAME", "openbrain"); },
  get DB_USER() { return opt("DB_USER", "openbrain"); },
  get DB_PASSWORD() { return req("DB_PASSWORD"); },
  get OB1_MCP_URL() { return opt("OB1_MCP_URL", "http://mcp:8000"); },
  get OB1_MCP_KEY() { return req("OB1_MCP_KEY"); },
  get DASHBOARD_PASSWORD() { return req("DASHBOARD_PASSWORD"); },
  get DASHBOARD_SESSION_SECRET() {
    return opt("DASHBOARD_SESSION_SECRET", process.env.OB1_MCP_KEY ?? "");
  },
  get SESSION_MAX_AGE_S() {
    return parseInt(opt("DASHBOARD_SESSION_MAX_AGE", "604800"), 10);
  },
  // When set (typically ".ob1.localhost" behind Traefik), the session
  // cookie is scoped to this domain so login persists across subdomains
  // (personal.ob1.localhost, tech-screen.ob1.localhost, …).
  get COOKIE_DOMAIN() {
    return opt("OB1_COOKIE_DOMAIN", "") || undefined;
  },
  // Own profile name, e.g. "personal", "tech-screen". Empty for the
  // default profile.
  get OB1_PROFILE() {
    return opt("OB1_PROFILE", "default");
  },
  // Comma-separated `name=url` pairs for sibling profiles, e.g.
  // "personal=http://localhost:3013,tech-screen=http://localhost:3011".
  // Computed by `make up` so users don't maintain it by hand.
  get OB1_PEER_PROFILES(): Array<{ name: string; url: string }> {
    const raw = opt("OB1_PEER_PROFILES", "");
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0) return null;
        const name = pair.slice(0, eq).trim();
        const url = pair.slice(eq + 1).trim();
        if (!name || !url) return null;
        return { name, url };
      })
      .filter((x): x is { name: string; url: string } => x !== null);
  },
};
