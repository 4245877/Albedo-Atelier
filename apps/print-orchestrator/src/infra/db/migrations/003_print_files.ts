import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("print_files", (table) => {
    table.uuid("id").primary();
    table.string("name").notNullable();
    table.string("path").notNullable();
    table.string("checksum");
    table.integer("estimated_seconds");
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("print_files");
}
