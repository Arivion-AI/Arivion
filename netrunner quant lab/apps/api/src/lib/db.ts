import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/duality";

export const db = new Pool({ connectionString: databaseUrl });

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
