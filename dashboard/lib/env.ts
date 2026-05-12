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
};
