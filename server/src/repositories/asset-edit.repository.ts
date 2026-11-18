import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetEditActionItem, AssetEditActionItemResponseDto } from 'src/dtos/editing.dto.js';
import { DB } from 'src/schema/index.js';

export type AssetEditSnapshot = { etag: string; edits: AssetEditActionItemResponseDto[] };
type AssetEditWriteResult =
  { status: 'committed'; snapshot: AssetEditSnapshot } | { status: 'missing' } | { status: 'stale' };

const editTag = (assetId: string, revision: string | null) => `"edit-${assetId}-${revision ?? 'initial'}"`;

@Injectable()
export class AssetEditRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  replaceAll(assetId: string, edits: AssetEditActionItem[], ifMatch?: string): Promise<AssetEditWriteResult> {
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // Every writer takes this lock, including requests from older clients and edits to an empty list.
        const asset = await trx
          .selectFrom('asset')
          .select(['id', 'editRevision'])
          .where('id', '=', assetId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!asset) {
          return { status: 'missing' };
        }
        if (ifMatch !== undefined && ifMatch !== editTag(asset.id, asset.editRevision)) {
          return { status: 'stale' };
        }

        const revision = randomUUID();
        await trx.updateTable('asset').set({ editRevision: revision }).where('id', '=', asset.id).execute();
        await trx.deleteFrom('asset_edit').where('assetId', '=', assetId).execute();

        const inserted =
          edits.length === 0
            ? []
            : await trx
                .insertInto('asset_edit')
                .values(edits.map((edit, sequence) => ({ assetId, sequence, ...edit })))
                .returning(['id', 'action', 'parameters', 'sequence'])
                .execute();
        return {
          status: 'committed',
          snapshot: {
            etag: editTag(asset.id, revision),
            edits: inserted
              .sort((a, b) => a.sequence - b.sequence)
              .map(({ id, action, parameters }) => ({ id, action, parameters })),
          },
        };
      });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getSnapshot(assetId: string): Promise<AssetEditSnapshot | undefined> {
    // The tag and ordered edits come from one statement, so they always describe the same committed state.
    const snapshot = await this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.editRevision'])
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset_edit')
            .select(['id', 'action', 'parameters'])
            .whereRef('asset_edit.assetId', '=', 'asset.id')
            .orderBy('sequence', 'asc'),
        ).as('edits'),
      )
      .where('asset.id', '=', assetId)
      .executeTakeFirst();

    return snapshot && { etag: editTag(snapshot.id, snapshot.editRevision), edits: snapshot.edits };
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getWithSyncInfo(assetId: string) {
    return this.db
      .selectFrom('asset_edit')
      .select(columns.syncAssetEdit)
      .where('assetId', '=', assetId)
      .orderBy('sequence', 'asc')
      .execute();
  }
}
