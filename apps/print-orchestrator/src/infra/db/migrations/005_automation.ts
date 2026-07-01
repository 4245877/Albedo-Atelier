import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("automation_rules", (table) => {
    table.uuid("id").primary();
    table.string("name").notNullable();
    table.boolean("enabled").notNullable().defaultTo(true);
    table.string("trigger").notNullable();
    table.json("actions").notNullable();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("automation_rules");
}
