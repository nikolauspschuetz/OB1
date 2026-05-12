import postgres, { type Sql } from "postgres";
import { env } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __ob1_sql: Sql | undefined;
}

let _sql: Sql | undefined = global.__ob1_sql;

function init(): Sql {
  const s = postgres({
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    max: 8,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  if (process.env.NODE_ENV !== "production") global.__ob1_sql = s;
  return s;
}

// postgres-js's sql is callable (sql`SELECT 1`) AND has methods. We
// proxy a function target so both work, lazy-initializing on first use.
// That lets this module be imported during Next.js build without env.
const target = function dummy() {} as unknown as Sql;
export const sql: Sql = new Proxy(target, {
  get(_t, prop) {
    if (!_sql) _sql = init();
    const v = (_sql as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === "function"
      ? (v as (...a: unknown[]) => unknown).bind(_sql)
      : v;
  },
  apply(_t, _thisArg, args) {
    if (!_sql) _sql = init();
    return (_sql as unknown as (...a: unknown[]) => unknown)(...args);
  },
});
