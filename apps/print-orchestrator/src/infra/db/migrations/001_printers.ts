import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("printers", (table) => {
    table.uuid("id").primary();
    table.string("name").notNullable();
    table.string("technology").notNullable();
    table.string("driver").notNullable();
    table.string("state").notNullable().defaultTo("offline");
    table.json("capabilities").notNullable();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("printers");
}
