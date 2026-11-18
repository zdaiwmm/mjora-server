import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Existing assets begin without a revision; this keeps the migration free of a table rewrite.
  await db.schema.alterTable('asset').addColumn('editRevision', 'uuid').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('asset').dropColumn('editRevision').execute();
}
