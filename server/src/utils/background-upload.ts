import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto.js';
import type { AssetMediaCreateDto } from 'src/dtos/asset-media.dto.js';

export const backgroundPartBytes = 8 * 1024 * 1024;
const lifetime = 7 * 24 * 60 * 60 * 1000;

export type BackgroundUpload = {
  id: string;
  owner: string;
  checksum: string;
  size: number;
  offset: number;
  key: string;
  capability: string;
  expiresAt: number;
  metadata: AssetMediaCreateDto;
  result?: AssetMediaResponseDto;
};

/** Call under the database advisory lock. Only ciphertext crosses the daemon boundary.
A public staging request has no authority to import, read, or delete an asset. */
export class BackgroundUploadStore {
  constructor(private root: string) {}

  directory(id: string) {
    if (!/^[a-f\d]{64}$/.test(id)) {
      throw new NotFoundException();
    }
    return join(this.root, id);
  }

  async read(id: string) {
    try {
      const value = JSON.parse(await readFile(join(this.directory(id), 'state.json'), 'utf8')) as BackgroundUpload;
      if (value.expiresAt < Date.now()) {
        throw new NotFoundException();
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException();
      }
      throw error;
    }
  }

  async save(value: BackgroundUpload) {
    const directory = this.directory(value.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.json.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, 'state.json'));
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  async start(owner: string, checksum: string, size: number, metadata: AssetMediaCreateDto) {
    const id = createHash('sha256')
      .update(JSON.stringify([owner, checksum, size, metadata]))
      .digest('hex');
    try {
      return await this.read(id);
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        throw error;
      }
    }
    // Bound abandoned uploads, including their disk reservations, per account.
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let active = 0;
    let reserved = 0;
    for (const name of await readdir(this.root)) {
      if (!/^[a-f\d]{64}$/.test(name)) {
        continue;
      }
      try {
        const item = await this.read(name);
        if (!item.result) {
          reserved += 2 * Math.max(0, item.size - item.offset);
        }
        if (item.owner === owner && !item.result) {
          active++;
        }
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          throw error;
        }
        await rm(this.directory(name), { recursive: true, force: true });
      }
    }
    if (active >= 16) {
      throw new BadRequestException('Too many unfinished background uploads');
    }
    const capacity = await statfs(this.root);
    if (reserved + 2 * size + 256 * 1024 * 1024 > capacity.bavail * capacity.bsize) {
      throw new BadRequestException('Insufficient storage for a resumable upload');
    }
    await rm(this.directory(id), { recursive: true, force: true });
    const value: BackgroundUpload = {
      id,
      owner,
      checksum,
      size,
      metadata,
      offset: 0,
      key: randomBytes(32).toString('base64'),
      capability: randomBytes(32).toString('hex'),
      expiresAt: Date.now() + lifetime,
    };
    await this.save(value);
    return value;
  }

  requireOwner(value: BackgroundUpload, owner: string) {
    if (value.owner !== owner) {
      throw new NotFoundException();
    }
  }

  authorize(value: BackgroundUpload, capability: string) {
    const expected = Buffer.from(value.capability, 'utf8');
    const proposed = Buffer.from(capability, 'utf8');
    if (value.result || proposed.length !== expected.length || !timingSafeEqual(expected, proposed)) {
      throw new UnauthorizedException();
    }
  }

  decrypt(value: BackgroundUpload, offset: number, sealed: Buffer) {
    const length = Math.min(backgroundPartBytes, value.size - offset);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= value.size ||
      offset % backgroundPartBytes !== 0 ||
      sealed.length !== length + 28
    ) {
      throw new BadRequestException('Invalid upload part');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(value.key, 'base64'), sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${value.id}:${offset}:${length}`, 'utf8'));
      decipher.setAuthTag(sealed.subarray(-16));
      return Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]);
    } catch {
      throw new BadRequestException('Invalid encrypted upload part');
    }
  }

  async stage(value: BackgroundUpload, offset: number, sealed: Buffer) {
    this.decrypt(value, offset, sealed);
    if (offset < value.offset) {
      return; // Idempotent replay of an acknowledged part.
    }
    const directory = this.directory(value.id);
    const temporary = join(directory, `${randomUUID()}.part.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(sealed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, `${offset}.part`));
  }

  /** The manifest offset is the durable acknowledgement. Roll back any append
  whose manifest write was interrupted before acknowledging further data. */
  async reconcile(value: BackgroundUpload) {
    if (value.result) {
      return;
    }
    const directory = this.directory(value.id);
    const file = await open(join(directory, 'original'), 'a+', 0o600);
    try {
      const information = await file.stat();
      const length = information.size;
      if (length < value.offset) {
        throw new BadRequestException('Upload recovery state is unavailable');
      }
      await file.truncate(value.offset);
      while (value.offset < value.size) {
        const part = join(directory, `${value.offset}.part`);
        let sealed: Buffer;
        try {
          sealed = await readFile(part);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            break;
          }
          throw error;
        }
        const data = this.decrypt(value, value.offset, sealed);
        await file.writeFile(data);
        await file.sync();
        value.offset += data.length;
        await this.save(value);
        await rm(part, { force: true });
      }
    } finally {
      await file.close();
    }
  }

  async verify(value: BackgroundUpload) {
    const path = join(this.directory(value.id), 'original');
    const information = await stat(path);
    if (information.size !== value.size) {
      throw new BadRequestException('Incomplete upload');
    }
    const hash = createHash('sha1');
    for await (const bytes of createReadStream(path)) {
      hash.update(bytes);
    }
    if (hash.digest('base64') !== value.checksum) {
      throw new BadRequestException('Upload checksum mismatch');
    }
    return path;
  }

  async complete(value: BackgroundUpload, result: AssetMediaResponseDto) {
    value.result = result;
    value.key = '';
    value.capability = '';
    await this.save(value);
    // The imported copy is outside the staging directory.
    await rm(join(this.directory(value.id), 'original'), { force: true });
  }

  async remove(value: BackgroundUpload) {
    await rm(this.directory(value.id), { recursive: true, force: true });
  }

  response(value: BackgroundUpload) {
    return {
      uploadId: value.id,
      offset: value.offset,
      size: value.size,
      partBytes: backgroundPartBytes,
      key: value.key,
      capability: value.capability,
      result: value.result,
    };
  }
}
