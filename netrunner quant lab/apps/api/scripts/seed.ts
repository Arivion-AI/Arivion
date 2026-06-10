import { db } from "../src/lib/db.js";

async function run(): Promise<void> {
  // §25: users.privy_did is the identity anchor (NOT NULL). The seed user gets a deterministic
  // dev DID so the seed remains idempotent under the Privy schema.
  await db.query(
    `
      INSERT INTO users (privy_did, email, display_name)
      VALUES ('did:seed:duality-local', 'seed@duality.local', 'Seed User')
      ON CONFLICT (privy_did) DO NOTHING
    `
  );
  await db.end();
  // eslint-disable-next-line no-console
  console.log("seed complete");
}

run().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  await db.end();
  process.exit(1);
});
