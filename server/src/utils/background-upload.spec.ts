import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import type { AssetMediaCreateDto } from 'src/dtos/asset-media.dto.js';
import { BackgroundUploadStore, backgroundPartBytes, type BackgroundUpload } from 'src/utils/background-upload.js';

const metadata = {
  filename: 'synthetic.mp4',
  fileCreatedAt: new Date('2026-01-01'),
  fileModifiedAt: new Date('2026-01-01'),
} as AssetMediaCreateDto;
function seal(value: BackgroundUpload, offset: number, data: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(value.key, 'base64'), nonce);
  cipher.setAAD(Buffer.from(`${value.id}:${offset}:${data.length}`));
  return Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

describe('encrypted background upload recovery', () => {
  let root: string;
  let store: BackgroundUploadStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'background-upload-'));
    store = new BackgroundUploadStore(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reserves the full final import copy even after most original bytes are acknowledged', async () => {
    const size = 10 * 1024 * 1024;
    store = new BackgroundUploadStore(root, () => Promise.resolve(256 * 1024 * 1024 + 26 * 1024 * 1024));
    const bytes = Buffer.alloc(size);
    const value = await store.start('owner', createHash('sha1').update(bytes).digest('base64'), size, metadata);
    await store.stage(value, 0, seal(value, 0, bytes.subarray(0, backgroundPartBytes)));
    await store.reconcile(value);
    expect(value.offset).toBe(backgroundPartBytes);
    await expect(store.start('owner', Buffer.alloc(20, 1).toString('base64'), size, metadata)).rejects.toThrow(
      'Insufficient storage',
    );
  });

  it('resumes across store recreation and out-of-order daemon completion without retransmitting acknowledged bytes', async () => {
    const data = randomBytes(backgroundPartBytes + 321);
    const checksum = createHash('sha1').update(data).digest('base64');
    let value = await store.start('owner', checksum, data.length, metadata);
    await store.stage(value, backgroundPartBytes, seal(value, backgroundPartBytes, data.subarray(backgroundPartBytes)));
    await store.reconcile(value);
    expect(value.offset).toBe(0);
    await store.stage(value, 0, seal(value, 0, data.subarray(0, backgroundPartBytes)));
    store = new BackgroundUploadStore(root);
    value = await store.start('owner', checksum, data.length, metadata);
    await store.reconcile(value);
    expect(value.offset).toBe(data.length);
    const original = await readFile(await store.verify(value));
    expect(original.equals(data)).toBe(true);
    const restored = await new BackgroundUploadStore(root).start('owner', checksum, data.length, metadata);
    expect(restored.offset).toBe(data.length);
  });

  it('rolls back bytes appended before a durable offset checkpoint', async () => {
    const data = randomBytes(backgroundPartBytes + 19);
    const value = await store.start('owner', createHash('sha1').update(data).digest('base64'), data.length, metadata);
    await store.stage(value, 0, seal(value, 0, data.subarray(0, backgroundPartBytes)));
    await store.reconcile(value);
    await appendFile(join(store.directory(value.id), 'original'), Buffer.from('interrupted append'));
    await store.stage(value, backgroundPartBytes, seal(value, backgroundPartBytes, data.subarray(backgroundPartBytes)));
    await store.reconcile(await store.read(value.id));
    const original = await readFile(await store.verify(await store.read(value.id)));
    expect(original.equals(data)).toBe(true);
  });

  it('rejects swapped offsets, tampering, oversized bodies, foreign owners and invalid capabilities', async () => {
    const data = randomBytes(backgroundPartBytes * 2);
    const value = await store.start('owner', createHash('sha1').update(data).digest('base64'), data.length, metadata);
    const encrypted = seal(value, 0, data.subarray(0, backgroundPartBytes));
    await expect(store.stage(value, backgroundPartBytes, encrypted)).rejects.toThrow('Invalid encrypted');
    encrypted[20] ^= 1;
    await expect(store.stage(value, 0, encrypted)).rejects.toThrow('Invalid encrypted');
    await expect(store.stage(value, 0, Buffer.alloc(backgroundPartBytes + 29))).rejects.toThrow('Invalid upload part');
    expect(() => store.requireOwner(value, 'different-owner')).toThrow();
    expect(() => store.authorize(value, 'bad-capability')).toThrow();
    expect(() => store.authorize(value, value.capability)).not.toThrow();
  });

  it('verifies the whole original before import and revokes staging after completion', async () => {
    const data = randomBytes(1234);
    const value = await store.start('owner', createHash('sha1').update(data).digest('base64'), data.length, metadata);
    await store.stage(value, 0, seal(value, 0, data));
    await store.reconcile(value);
    await writeFile(join(store.directory(value.id), 'original'), randomBytes(data.length));
    await expect(store.verify(value)).rejects.toThrow('checksum mismatch');
    await writeFile(join(store.directory(value.id), 'original'), data);
    await store.verify(value);
    await store.complete(value, { id: 'asset-id', status: AssetMediaStatus.CREATED });
    const restored = await store.read(value.id);
    expect(restored.result?.id).toBe('asset-id');
    expect(() => store.authorize(value, value.capability)).toThrow();
    await expect(readFile(join(store.directory(value.id), 'original'))).rejects.toThrow();
  });

  it('cancellation removes only staging and prevents delayed uploads from resuming it', async () => {
    const value = await store.start('owner', Buffer.alloc(20).toString('base64'), 10, metadata);
    await store.remove(value);
    await expect(store.read(value.id)).rejects.toThrow();
  });

  it('reclaims an inactive session before enforcing the per-account cap', async () => {
    const values: BackgroundUpload[] = [];
    for (let index = 0; index < 16; index++) {
      values.push(
        await store.start('owner', createHash('sha1').update(String(index)).digest('base64'), 10, {
          ...metadata,
          filename: `${index}.jpg`,
        }),
      );
    }
    await expect(store.start('owner', createHash('sha1').update('17').digest('base64'), 10, metadata)).rejects.toThrow(
      'Too many unfinished background uploads',
    );

    const stale = values[0];
    const statePath = join(store.directory(stale.id), 'state.json');
    await writeFile(statePath, JSON.stringify({ ...stale, updatedAt: Date.now() - 25 * 60 * 60 * 1000 }));

    await expect(
      store.start('owner', createHash('sha1').update('17').digest('base64'), 10, metadata),
    ).resolves.toBeDefined();
    await expect(store.read(stale.id)).rejects.toThrow();
  });

  it('refreshes activity when a recent interrupted session is reopened', async () => {
    const value = await store.start('owner', Buffer.alloc(20).toString('base64'), 10, metadata);
    const statePath = join(store.directory(value.id), 'state.json');
    await writeFile(statePath, JSON.stringify({ ...value, updatedAt: Date.now() - 23 * 60 * 60 * 1000 }));

    const reopened = await store.start('owner', value.checksum, value.size, value.metadata);
    expect(reopened.id).toBe(value.id);
    expect(reopened.updatedAt).toBeGreaterThan(Date.now() - 5000);
  });

  it('resets an inactive session even when it is the next requested item', async () => {
    const value = await store.start('owner', Buffer.alloc(20).toString('base64'), 10, metadata);
    const statePath = join(store.directory(value.id), 'state.json');
    await writeFile(statePath, JSON.stringify({ ...value, offset: 5, updatedAt: Date.now() - 25 * 60 * 60 * 1000 }));

    const reopened = await store.start('owner', value.checksum, value.size, value.metadata);
    expect(reopened.id).toBe(value.id);
    expect(reopened.offset).toBe(0);
    expect(reopened.updatedAt).toBeGreaterThan(Date.now() - 5000);
  });
});
