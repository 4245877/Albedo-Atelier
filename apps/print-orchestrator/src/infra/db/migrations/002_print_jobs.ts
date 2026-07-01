import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("print_jobs", (table) => {
    table.uuid("id").primary();
    table.uuid("printer_id").references("id").inTable("printers").onDelete("SET NULL");
    table.uuid("file_id");
    table.uuid("material_id");
    table.string("state").notNullable().defaultTo("draft");
    table.integer("priority").notNullable().defaultTo(0);
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("print_jobs");
}
