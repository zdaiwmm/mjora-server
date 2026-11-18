import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

describe('conditional asset edits', () => {
  it('gives a revision to only one concurrent writer and invalidates it even after an older client resets the edits', async () => {
    await utils.resetDatabase();
    const account = await utils.adminSetup({ onboarding: false });
    const socket = await utils.connectWebsocket(account.accessToken);
    try {
      const asset = await utils.createAsset(account.accessToken);
      await utils.waitForWebsocketEvent({ event: 'assetUpload', id: asset.id });
      const auth = asBearerAuth(account.accessToken);
      const path = `/assets/${asset.id}/edits`;
      const versioned = `${path}/versioned`;

      const opening = await request(app).get(path).set(auth).expect(200).expect('Cache-Control', 'no-store');
      const initial = opening.headers.etag;
      expect(initial).toMatch(/^"edit-[^"]+"$/);
      expect(opening.body.edits).toEqual([]);

      const first = { edits: [{ action: 'rotate', parameters: { angle: 90 } }] };
      const second = { edits: [{ action: 'rotate', parameters: { angle: 270 } }] };
      const [a, b] = await Promise.all([
        request(app).put(versioned).set(auth).set('If-Match', initial).send(first),
        request(app).put(versioned).set(auth).set('If-Match', initial).send(second),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 412]);
      const winner = a.status === 200 ? a : b;
      const current = await request(app).get(path).set(auth).expect(200).expect('ETag', winner.headers.etag);
      expect(current.headers.etag).not.toBe(initial);
      expect(current.body.edits).toMatchObject((a.status === 200 ? first : second).edits);
      await request(app).delete(versioned).set(auth).set('If-Match', initial).expect(412);

      await request(app).delete(path).set(auth).expect(204);
      const reset = await request(app).get(path).set(auth).expect(200);
      expect(reset.body.edits).toEqual([]);
      expect(reset.headers.etag).not.toBe(initial);
      expect(reset.headers.etag).not.toBe(current.headers.etag);
      await request(app).put(versioned).set(auth).set('If-Match', initial).send(first).expect(412);
    } finally {
      utils.disconnectWebsocket(socket);
    }
  }, 30_000);
});
