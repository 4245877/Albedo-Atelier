import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("materials", (table) => {
    table.uuid("id").primary();
    table.string("name").notNullable();
    table.string("kind").notNullable();
    table.string("color");
    table.string("manufacturer");
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("materials");
}
