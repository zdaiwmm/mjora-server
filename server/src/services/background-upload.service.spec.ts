import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { BackgroundUploadCreateDto } from 'src/dtos/background-upload.dto.js';
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

  async function startAndStage() {
    const state = await service.start(authStub.user1, dto);
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
