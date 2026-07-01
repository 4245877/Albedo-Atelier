import { db } from "./knex";

async function migrate(): Promise<void> {
  await db.migrate.latest();
  await db.destroy();
}

void migrate();
