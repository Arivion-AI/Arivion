import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/lib/db.js";

async function waitForDatabase(maxAttempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await db.query("SELECT 1");
      return;
    } catch {
      if (attempt === maxAttempts) {
        throw new Error("Database did not become available in time.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function run(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await waitForDatabase();

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = resolve(here, "../migrations");
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const alreadyApplied = await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = $1",
      [file]
    );
    if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
      continue;
    }

    const sql = await readFile(resolve(migrationsDir, file), "utf8");
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await db.query("COMMIT");
      // eslint-disable-next-line no-console
      console.log(`applied migration ${file}`);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  await db.end();
  // eslint-disable-next-line no-console
  console.log("migrations complete");
}

run().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  await db.end();
  process.exit(1);
});
