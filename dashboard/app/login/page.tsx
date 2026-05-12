import { redirect } from "next/navigation";
import { getSession } from "../../lib/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await getSession()) redirect("/");
  const { error, next } = await searchParams;
  return (
    <div className="max-w-sm mx-auto mt-16">
      <h1 className="text-xl font-semibold mb-4">Open Brain</h1>
      <p className="text-sm mb-4" style={{ color: "var(--color-text-dim)" }}>
        Sign in with the dashboard password.
      </p>
      <form action="/api/login" method="post" className="space-y-3">
        <input
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="password"
          className="w-full card px-3 py-2"
          style={{ background: "var(--color-bg)" }}
        />
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <button type="submit" className="btn btn-primary w-full">
          Sign in
        </button>
        {error ? (
          <p className="text-sm" style={{ color: "#f7768e" }}>
            {error === "bad" ? "Incorrect password" : "Sign-in failed"}
          </p>
        ) : null}
      </form>
    </div>
  );
}
