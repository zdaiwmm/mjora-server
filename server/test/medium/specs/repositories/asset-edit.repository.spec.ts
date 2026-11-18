import { Kysely } from 'kysely';
import { AssetEditAction, AssetEditActionItem, MirrorAxis } from 'src/dtos/editing.dto.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

// eslint-disable-next-line unicorn/no-unnecessary-parameters
const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetEditRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetEditRepository.name, () => {
  describe('replaceAll', () => {
    it('rolls back the full replacement if inserting the new list fails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const prior = await sut.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }]);
      if (prior.status !== 'committed') {
        throw new Error('Could not save initial edit');
      }
      await expect(
        sut.replaceAll(
          asset.id,
          [{ action: AssetEditAction.Photo, parameters: null }] as unknown as AssetEditActionItem[],
          prior.snapshot.etag,
        ),
      ).rejects.toThrow();
      await expect(sut.getSnapshot(asset.id)).resolves.toEqual(prior.snapshot);
    });

    it('rejects stale saves and clears after an older client writes the edit', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const initial = (await sut.getSnapshot(asset.id))!;
      const action = { action: AssetEditAction.Rotate, parameters: { angle: 90 } } as const;
      await sut.replaceAll(asset.id, [action]);
      const latest = (await sut.getSnapshot(asset.id))!;

      expect(latest.etag).not.toEqual(initial.etag);
      expect(latest.edits).toMatchObject([action]);
      await expect(sut.replaceAll(asset.id, [action], initial.etag)).resolves.toEqual({ status: 'stale' });
      await expect(sut.replaceAll(asset.id, [], initial.etag)).resolves.toEqual({ status: 'stale' });
      await expect(sut.getSnapshot(asset.id)).resolves.toEqual(latest);
    });

    it('never reuses an earlier tag when the edit list returns to empty', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const initial = (await sut.getSnapshot(asset.id))!;
      const action = { action: AssetEditAction.Rotate, parameters: { angle: 90 } } as const;
      await sut.replaceAll(asset.id, [action]);
      const edited = (await sut.getSnapshot(asset.id))!;
      await expect(sut.replaceAll(asset.id, [], edited.etag)).resolves.toMatchObject({ status: 'committed' });

      const cleared = (await sut.getSnapshot(asset.id))!;
      expect(cleared.edits).toEqual(initial.edits);
      expect(cleared.etag).not.toEqual(initial.etag);
      await expect(sut.replaceAll(asset.id, [action], initial.etag)).resolves.toEqual({ status: 'stale' });
    });

    it('commits only one of two simultaneous saves with the same observed tag', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const initial = (await sut.getSnapshot(asset.id))!;
      const results = await Promise.all([
        sut.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }], initial.etag),
        sut.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }], initial.etag),
      ]);

      expect(results.map(({ status }) => status).sort()).toEqual(['committed', 'stale']);
      const winner = results.find((result) => result.status === 'committed');
      await expect(sut.getSnapshot(asset.id)).resolves.toEqual(winner?.snapshot);
    });

    it('should set isEdited on insert', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: false });

      await sut.replaceAll(asset.id, [
        { action: AssetEditAction.Crop, parameters: { height: 1, width: 1, x: 1, y: 1 } },
      ]);

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: true });
    });

    it('should set isEdited when inserting multiple edits', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: false });

      await sut.replaceAll(asset.id, [
        { action: AssetEditAction.Crop, parameters: { height: 1, width: 1, x: 1, y: 1 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: true });
    });

    it('should keep isEdited when removing some edits', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: false });

      await sut.replaceAll(asset.id, [
        { action: AssetEditAction.Crop, parameters: { height: 1, width: 1, x: 1, y: 1 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: true });

      await sut.replaceAll(asset.id, [
        { action: AssetEditAction.Crop, parameters: { height: 1, width: 1, x: 1, y: 1 } },
      ]);

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: true });
    });

    it('should set isEdited to false if all edits are deleted', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: false });

      await sut.replaceAll(asset.id, [
        { action: AssetEditAction.Crop, parameters: { height: 1, width: 1, x: 1, y: 1 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      await sut.replaceAll(asset.id, []);

      await expect(
        ctx.database.selectFrom('asset').select('isEdited').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ isEdited: false });
    });
  });
});
