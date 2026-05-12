import { requireSession } from "../../lib/auth";
import { env } from "../../lib/env";

export const dynamic = "force-dynamic";

interface Healthz {
  status: string;
  db?: string;
  embedding?: { last_success?: string | null; stale?: boolean };
  [k: string]: unknown;
}

async function fetchJson<T>(path: string): Promise<T | { __error: string }> {
  try {
    const resp = await fetch(`${env.OB1_MCP_URL}${path}`, {
      cache: "no-store",
      headers: { "x-brain-key": env.OB1_MCP_KEY },
    });
    if (!resp.ok) {
      return { __error: `${resp.status} ${resp.statusText}` };
    }
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return await resp.json() as T;
    }
    // /metrics is text/plain
    return { __error: "non-json" };
  } catch (e) {
    return { __error: (e as Error).message };
  }
}

async function fetchText(path: string): Promise<string> {
  try {
    const resp = await fetch(`${env.OB1_MCP_URL}${path}`, {
      cache: "no-store",
      headers: { "x-brain-key": env.OB1_MCP_KEY },
    });
    if (!resp.ok) return `error: ${resp.status}`;
    return await resp.text();
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

export default async function HealthPage() {
  await requireSession();
  const [hz, metrics] = await Promise.all([
    fetchJson<Healthz>("/healthz"),
    fetchText("/metrics"),
  ]);

  const summary: Array<[string, string]> = [];
  if ("__error" in hz) {
    summary.push(["status", `unreachable: ${hz.__error}`]);
  } else {
    summary.push(["status", hz.status ?? "?"]);
    if (hz.db) summary.push(["db", hz.db]);
    if (hz.embedding?.last_success) {
      summary.push(["embedding last_success", hz.embedding.last_success]);
    }
    if (hz.embedding?.stale !== undefined) {
      summary.push(["embedding stale", String(hz.embedding.stale)]);
    }
  }

  const keyCounters = metrics.split("\n").filter((l) =>
    l.startsWith("ob1_captures_total") ||
    l.startsWith("ob1_searches_total") ||
    l.startsWith("ob1_chat_requests_total") ||
    l.startsWith("ob1_embedding_requests_total")
  );

  return (
    <>
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Health</h1>
      </header>

      <section className="mb-6">
        <h2 className="text-sm font-semibold mb-2">Summary</h2>
        <table className="card" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <tbody>
            {summary.map(([k, v]) => (
              <tr key={k}>
                <td style={{ padding: "0.4rem 0.8rem", color: "var(--color-text-dim)", borderBottom: "1px solid var(--color-border)" }}>{k}</td>
                <td style={{ padding: "0.4rem 0.8rem", borderBottom: "1px solid var(--color-border)" }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold mb-2">Hot counters (last scrape)</h2>
        <pre className="card p-3 text-xs overflow-x-auto">
{keyCounters.join("\n") || "(no matches in /metrics)"}
        </pre>
      </section>

      <details>
        <summary className="cursor-pointer text-sm" style={{ color: "var(--color-text-dim)" }}>
          Raw /healthz JSON
        </summary>
        <pre className="card p-3 mt-2 text-xs overflow-x-auto">
{JSON.stringify(hz, null, 2)}
        </pre>
      </details>
    </>
  );
}
