import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { BackgroundUploadController } from 'src/controllers/background-upload.controller.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { BackgroundUploadService } from 'src/services/background-upload.service.js';
import type { UploadFile } from 'src/types.js';
import { authStub } from 'test/fixtures/auth.stub.js';

describe('background upload HTTP contract', () => {
  let app: INestApplication;
  let root: string;
  const data = Buffer.from('synthetic HTTP video');
  const metadata = {
    filename: 'fixture.mp4',
    fileCreatedAt: '2026-01-01T00:00:00Z',
    fileModifiedAt: '2026-01-01T00:00:00Z',
    size: data.length,
    checksum: createHash('sha1').update(data).digest('base64'),
  };
  const assets = {
    getUploadAssetIdByChecksum: vi.fn().mockResolvedValue(undefined),
    requireQuota: vi.fn(),
    canUploadFile: vi.fn(),
    getUploadFolder: () => join(root, 'imported'),
    getUploadFilename: ({ file }: { file: UploadFile }) => `${file.uuid}.mp4`,
    uploadAsset: vi.fn().mockResolvedValue({ id: 'fixture-asset', status: AssetMediaStatus.CREATED }),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'background-http-'));
    await mkdir(join(root, 'imported'));
    vi.spyOn(StorageCore, 'getBaseFolder').mockReturnValue(root);
    const module = await Test.createTestingModule({
      controllers: [BackgroundUploadController],
      providers: [
        BackgroundUploadService,
        { provide: AssetMediaService, useValue: assets },
        { provide: DatabaseRepository, useValue: { withLock: (_: unknown, callback: () => unknown) => callback() } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalGuards({
      canActivate(context) {
        const req = context.switchToHttp().getRequest();
        if (!req.path.includes('/parts/')) {
          if (req.headers.authorization !== 'Bearer synthetic-fixture') {
            throw new UnauthorizedException();
          }
          req.user = authStub.user1;
        }
        return true;
      },
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each([undefined, false, true])('validates JSON once and imports authenticated favorite=%s', async (favorite) => {
    const opened = await request(app.getHttpServer())
      .post('/api/assets/background-uploads')
      .set('Authorization', 'Bearer synthetic-fixture')
      .send({ ...metadata, ...(favorite === undefined ? {} : { isFavorite: String(favorite) }) })
      .expect(201);
    expect(opened.headers['cache-control']).toBe('no-store');
    const state = opened.body;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(state.key, 'base64'), nonce);
    cipher.setAAD(Buffer.from(`${state.uploadId}:0:${data.length}`));
    const sealed = Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    await request(app.getHttpServer())
      .put(`/api/assets/background-uploads/${state.uploadId}/parts/0`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Upload-Capability', state.capability)
      .send(sealed)
      .expect(204);
    expect(assets.uploadAsset).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post(`/api/assets/background-uploads/${state.uploadId}/status`).expect(401);
    const result = await request(app.getHttpServer())
      .post(`/api/assets/background-uploads/${state.uploadId}/status`)
      .set('Authorization', 'Bearer synthetic-fixture')
      .expect(200);
    expect(result.body.result.id).toBe('fixture-asset');
    const imported = assets.uploadAsset.mock.calls[0][2] as UploadFile;
    const bytes = await readFile(imported.originalPath);
    expect(bytes.equals(data)).toBe(true);
    expect(assets.uploadAsset.mock.calls[0][1].isFavorite).toBe(favorite);
  });

  it('rejects invalid metadata before allocating staging and rejects missing staging capabilities', async () => {
    await request(app.getHttpServer())
      .post('/api/assets/background-uploads')
      .set('Authorization', 'Bearer synthetic-fixture')
      .send({ ...metadata, isFavorite: false })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/assets/background-uploads')
      .set('Authorization', 'Bearer synthetic-fixture')
      .send({ ...metadata, size: -1 })
      .expect(400);
    const opened = await request(app.getHttpServer())
      .post('/api/assets/background-uploads')
      .set('Authorization', 'Bearer synthetic-fixture')
      .send(metadata)
      .expect(201);
    await request(app.getHttpServer())
      .put(`/api/assets/background-uploads/${opened.body.uploadId}/parts/0`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(data.length + 28))
      .expect(401);
    expect(assets.uploadAsset).not.toHaveBeenCalled();
  });
});
