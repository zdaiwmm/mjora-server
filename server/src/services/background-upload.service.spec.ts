import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { BackgroundUploadCreateDto } from 'src/dtos/background-upload.dto.js';
import { AssetVisibility } from 'src/enum.js';
import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { AssetMediaService } from 'src/services/asset-media.service.js';
import { BackgroundUploadService } from 'src/services/background-upload.service.js';
import type { UploadFile } from 'src/types.js';
import { authStub } from 'test/fixtures/auth.stub.js';

describe('background upload authorization and import', () => {
  let root: string;
  let service: BackgroundUploadService;
  let assets: ReturnType<typeof mockAssets>;
  const data = Buffer.from('synthetic video data');
  const dto = BackgroundUploadCreateDto.schema.parse({
    filename: 'fixture.mp4',
    fileCreatedAt: '2026-01-01T00:00:00Z',
    fileModifiedAt: '2026-01-01T00:00:00Z',
    size: data.length,
    checksum: createHash('sha1').update(data).digest('base64'),
  });

  function mockAssets() {
    return {
      getUploadAssetIdByChecksum: vi.fn().mockResolvedValue(undefined),
      requireQuota: vi.fn(),
      canUploadFile: vi.fn(),
      getUploadFolder: vi.fn().mockImplementation(() => join(root, 'imported')),
      getUploadFilename: vi.fn().mockImplementation(({ file }: { file: UploadFile }) => `${file.uuid}.mp4`),
      uploadAsset: vi.fn().mockResolvedValue({ id: 'asset', status: AssetMediaStatus.CREATED }),
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'background-service-'));
    await mkdir(join(root, 'imported'));
    vi.spyOn(StorageCore, 'getBaseFolder').mockReturnValue(root);
    assets = mockAssets();
    service = new BackgroundUploadService(
      assets as unknown as AssetMediaService,
      { withLock: (_: unknown, callback: () => unknown) => callback() } as unknown as DatabaseRepository,
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function startAndStage(input = dto) {
    const state = await service.start(authStub.user1, input);
    if (!('uploadId' in state)) {
      throw new Error('Unexpected duplicate');
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(state.key, 'base64'), nonce);
    cipher.setAAD(Buffer.from(`${state.uploadId}:0:${data.length}`));
    const sealed = Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    await service.stage(state.uploadId, state.capability, 0, sealed);
    return state;
  }

  it('daemon staging alone never imports; authenticated status verifies and imports exactly once', async () => {
    const state = await startAndStage();
    expect(assets.uploadAsset).not.toHaveBeenCalled();
    const status = await service.status(authStub.user1, state.uploadId);
    expect(status.offset).toBe(data.length);
    expect(status.result?.id).toBe('asset');
    const imported = assets.uploadAsset.mock.calls[0][2] as UploadFile;
    const original = await readFile(imported.originalPath);
    expect(original.equals(data)).toBe(true);
    expect(imported.checksum.toString('base64')).toBe(dto.checksum);
    assets.getUploadAssetIdByChecksum.mockResolvedValue({ id: 'asset', status: AssetMediaStatus.DUPLICATE });
    await service.status(authStub.user1, state.uploadId);
    expect(assets.uploadAsset).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('imports persisted parsed favorite=%s after reopening the service', async (favorite) => {
    const input = BackgroundUploadCreateDto.schema.parse({
      filename: 'fixture.mp4',
      fileCreatedAt: '2026-01-01T00:00:00Z',
      fileModifiedAt: '2026-01-02T00:00:00Z',
      size: data.length,
      checksum: dto.checksum,
      isFavorite: String(favorite),
      visibility: AssetVisibility.HIDDEN,
      livePhotoVideoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      metadata: JSON.stringify([{ key: 'fixture', value: { description: 'synthetic metadata' } }]),
    });
    expect(input.isFavorite).toBe(favorite);
    const state = await startAndStage(input);
    const saved = JSON.parse(await readFile(join(root, '.background-v1', state.uploadId, 'state.json'), 'utf8'));
    expect(saved.metadata.isFavorite).toBe(favorite);
    expect(saved.metadata.fileCreatedAt).toBe('2026-01-01T00:00:00.000Z');
    const reopened = new BackgroundUploadService(
      assets as unknown as AssetMediaService,
      { withLock: (_: unknown, callback: () => unknown) => callback() } as unknown as DatabaseRepository,
    );
    const status = await reopened.status(authStub.user1, state.uploadId);
    expect(status.result?.id).toBe('asset');
    const importedMetadata = assets.uploadAsset.mock.calls[0][1];
    expect(importedMetadata).toEqual({
      filename: input.filename,
      fileCreatedAt: input.fileCreatedAt,
      fileModifiedAt: input.fileModifiedAt,
      isFavorite: favorite,
      visibility: input.visibility,
      livePhotoVideoId: input.livePhotoVideoId,
      metadata: input.metadata,
    });
    const imported = assets.uploadAsset.mock.calls[0][2] as UploadFile;
    expect((await readFile(imported.originalPath)).equals(data)).toBe(true);
    assets.getUploadAssetIdByChecksum.mockResolvedValue({ id: 'asset', status: AssetMediaStatus.DUPLICATE });
    await reopened.status(authStub.user1, state.uploadId);
    expect(assets.uploadAsset).toHaveBeenCalledTimes(1);
  });

  it.each([
    { isFavorite: 'false' },
    { isFavorite: 0 },
    { isFavorite: {} },
    { filename: true },
    { fileCreatedAt: 'invalid-date' },
    { fileModifiedAt: 77 },
    { visibility: 'invalid-visibility' },
    { metadata: [{ key: 'fixture', value: [] }] },
  ])('rejects invalid persisted metadata before importing: %j', async (invalid) => {
    const state = await startAndStage();
    const path = join(root, '.background-v1', state.uploadId, 'state.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    Object.assign(saved.metadata, invalid);
    await writeFile(path, JSON.stringify(saved));
    await expect(service.status(authStub.user1, state.uploadId)).rejects.toThrow();
    expect(assets.getUploadFolder).not.toHaveBeenCalled();
    expect(assets.uploadAsset).not.toHaveBeenCalled();
  });

  it('foreign accounts and revoked upload permission cannot acknowledge or import staged bytes', async () => {
    const state = await startAndStage();
    await expect(service.status(authStub.admin, state.uploadId)).rejects.toThrow();
    assets.getUploadAssetIdByChecksum.mockRejectedValue(new Error('permission revoked'));
    await expect(service.status(authStub.user1, state.uploadId)).rejects.toThrow('permission revoked');
    expect(assets.uploadAsset).not.toHaveBeenCalled();
  });

  it('quota is checked before staging and again before final import', async () => {
    const state = await startAndStage();
    assets.requireQuota.mockImplementation(() => {
      throw new Error('quota');
    });
    await expect(service.status(authStub.user1, state.uploadId)).rejects.toThrow('quota');
    expect(assets.uploadAsset).not.toHaveBeenCalled();
  });

  it('an old completed receipt cannot identify a deleted cloud copy as backed up', async () => {
    const state = await startAndStage();
    await service.status(authStub.user1, state.uploadId);
    await expect(service.status(authStub.user1, state.uploadId)).rejects.toThrow('cloud copy was removed');
    const fresh = await service.start(authStub.user1, dto);
    expect('offset' in fresh && fresh.offset).toBe(0);
    expect('capability' in fresh && fresh.capability).not.toBe(state.capability);
  });
});
