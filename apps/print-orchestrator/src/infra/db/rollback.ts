import { db } from "./knex";

async function rollback(): Promise<void> {
  await db.migrate.rollback();
  await db.destroy();
}

void rollback();
