import { createClient } from "@libsql/client";

// One client per server process. DATABASE_URL is either:
//   - file:../espn_ff_1083280.db          (local dev -- reads the file the
//                                           Python pipeline writes to)
//   - libsql://your-db.turso.io           (production -- Turso, needs
//                                           DATABASE_AUTH_TOKEN too)
// Same query code works against either.
let client;

function getClient() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. For local dev, copy web/.env.local.example to web/.env.local."
      );
    }
    client = createClient({
      url,
      authToken: process.env.DATABASE_AUTH_TOKEN,
    });
  }
  return client;
}

/** Run a query and return plain JS objects (array of row objects). */
export async function query(sql, args = []) {
  const db = getClient();
  const result = await db.execute({ sql, args });
  return result.rows.map((row) => {
    const obj = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}
