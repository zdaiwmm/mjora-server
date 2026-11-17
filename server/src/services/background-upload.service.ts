import { BadRequestException, GoneException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import z from 'zod';
import { StorageCore } from 'src/cores/storage.core.js';
import { UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { type AuthDto } from 'src/dtos/auth.dto.js';
import { BackgroundUploadCreateDto } from 'src/dtos/background-upload.dto.js';
import { DatabaseLock, StorageFolder } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { type UploadFile } from 'src/types.js';
import { BackgroundUploadStore } from 'src/utils/background-upload.js';
import { fromChecksum } from 'src/utils/request.js';

const StoredUploadMetadataSchema = BackgroundUploadCreateDto.schema
  .omit({ checksum: true, size: true })
  .extend({ isFavorite: z.boolean().optional() });

@Injectable()
export class BackgroundUploadService {
  constructor(
    private assets: AssetMediaService,
    private database: DatabaseRepository,
  ) {}

  private get store() {
    return new BackgroundUploadStore(join(StorageCore.getBaseFolder(StorageFolder.Upload), '.background-v1'));
  }

  async start(auth: AuthDto, dto: BackgroundUploadCreateDto) {
    const { checksum: inputChecksum, size, ...metadata } = dto;
    const checksum = fromChecksum(inputChecksum);
    if (checksum.length !== 20 || auth.sharedLink) {
      throw new BadRequestException('Unsupported background upload');
    }
    const duplicate = await this.assets.getUploadAssetIdByChecksum(auth, inputChecksum);
    if (duplicate) {
      return { result: duplicate };
    }
    this.assets.requireQuota(auth, size);
    const file: UploadFile = { uuid: randomUUID(), checksum, size, originalName: dto.filename, originalPath: '' };
    this.assets.canUploadFile({ auth, file, fieldName: UploadFieldName.ASSET_DATA, body: metadata });
    return this.database.withLock(DatabaseLock.BackgroundUploads, async () => {
      const store = this.store;
      let value = await store.start(auth.user.id, checksum.toString('base64'), size, metadata);
      if (value.result) {
        // A deliberately removed cloud copy must not be resurrected by an old receipt.
        await store.remove(value);
        value = await store.start(auth.user.id, checksum.toString('base64'), size, metadata);
      }
      return store.response(value);
    });
  }

  async status(auth: AuthDto, id: string) {
    return this.database.withLock(DatabaseLock.BackgroundUploads, async () => {
      const store = this.store;
      const value = await store.read(id);
      store.requireOwner(value, auth.user.id);
      // This lookup also rechecks current upload permission.
      const duplicate = await this.assets.getUploadAssetIdByChecksum(auth, value.checksum);
      if (duplicate) {
        await store.complete(value, duplicate);
        return store.response(value);
      }
      if (value.result) {
        throw new GoneException('The cloud copy was removed');
      }
      this.assets.requireQuota(auth, value.size);
      await store.reconcile(value);
      if (value.offset === value.size) {
        const original = await store.verify(value);
        const metadata = StoredUploadMetadataSchema.parse(value.metadata);
        const file: UploadFile = {
          uuid: randomUUID(),
          checksum: Buffer.from(value.checksum, 'base64'),
          size: value.size,
          originalName: metadata.filename!,
          originalPath: '',
        };
        const request = { auth, file, fieldName: UploadFieldName.ASSET_DATA, body: metadata };
        file.originalPath = join(this.assets.getUploadFolder(request), this.assets.getUploadFilename(request));
        await copyFile(original, file.originalPath);
        const result = await this.assets.uploadAsset(auth, metadata, file);
        await store.complete(value, result);
      }
      return store.response(value);
    });
  }

  async authorizePart(id: string, capability: string) {
    const value = await this.store.read(id);
    this.store.authorize(value, capability);
  }

  async stage(id: string, capability: string, offset: number, sealed: Buffer) {
    return this.database.withLock(DatabaseLock.BackgroundUploads, async () => {
      const store = this.store;
      const value = await store.read(id);
      store.authorize(value, capability);
      await store.stage(value, offset, sealed);
    });
  }

  async cancel(auth: AuthDto, id: string) {
    return this.database.withLock(DatabaseLock.BackgroundUploads, async () => {
      const store = this.store;
      const value = await store.read(id);
      store.requireOwner(value, auth.user.id);
      await store.remove(value);
    });
  }
}
