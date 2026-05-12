// Cursor pagination via base64url-encoded (created_at, id) tuple.
// Stable across inserts because (created_at, id) is unique-and-ordered.

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (
      parsed && typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string"
    ) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}
