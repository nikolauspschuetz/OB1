// Edge-runtime-safe primitives. No `next/headers` import here.

const SECRET = process.env.DASHBOARD_SESSION_SECRET ?? process.env.OB1_MCP_KEY ?? "";
const MAX_AGE_S = parseInt(process.env.DASHBOARD_SESSION_MAX_AGE ?? "604800", 10);

function b64url(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "==".slice(0, (4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(msg),
  );
  return b64url(sig);
}

export async function signSession(): Promise<string> {
  const issued = Math.floor(Date.now() / 1000).toString();
  const sig = await hmac(issued);
  return `${issued}.${sig}`;
}

export async function verifySession(token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [issued, sig] = parts;
  if (!/^[0-9]+$/.test(issued)) return false;
  const age = Math.floor(Date.now() / 1000) - parseInt(issued, 10);
  if (age < 0 || age > MAX_AGE_S) return false;
  const expected = await hmac(issued);
  const a = b64urlDecode(sig);
  const b = b64urlDecode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function checkPassword(input: string): boolean {
  const pw = process.env.DASHBOARD_PASSWORD ?? "";
  if (!pw) return false;
  const a = new TextEncoder().encode(input);
  const b = new TextEncoder().encode(pw);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const SESSION_MAX_AGE_S = MAX_AGE_S;
