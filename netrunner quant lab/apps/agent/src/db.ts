import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

// The agent reads/writes the agent_* tables. Schema + migrations are owned by apps/api
// (apps/api/migrations) — this is a second reader/writer on the same database (see
// COPILOT_IMPLEMENTATION_NOTES.md). Money columns are BIGINT; pg returns BIGINT as string, so
// callers must Number()/BigInt() explicitly.
export const db = new Pool({ connectionString: config.databaseUrl });

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type DbClient = pg.PoolClient;
