import { eventManager } from '#lib/managers/event-manager.svelte.ts';
import { TimelineManager } from '#lib/managers/timeline-manager/timeline-manager.svelte.ts';
import { toTimelineAsset } from '#lib/utils/timeline-util.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { AssetVisibility } from '@immich/sdk';
import { expect } from 'vitest';

test('reconnect removes photos deleted while the websocket was disconnected', async ({ data, settle }) => {
  const [removed, retained] = [factory.asset(), factory.asset()];
  data.addAssets([removed, retained]);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await Promise.all(timeline.months.map((month) => timeline.loadTimelineMonth(month.yearMonth)));
    await settle();
    expect(timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id)).toContain(removed.id);

    data.deleteAssets([removed.id], true);
    eventManager.emit('WebsocketReconnect');
    await settle();
    await expect
      .poll(() => timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id))
      .not.toContain(removed.id);
    await expect
      .poll(() => timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id))
      .toContain(retained.id);

    const ids = timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id);
    expect(ids).not.toContain(removed.id);
    expect(ids).toContain(retained.id);
  } finally {
    timeline.destroy();
  }
});

test('reconnect revalidates membership even when deletion is balanced by a new photo', async ({ data, settle }) => {
  const [removed, retained, added] = [factory.asset(), factory.asset(), factory.asset()];
  data.addAssets([removed, retained]);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await Promise.all(timeline.months.map((month) => timeline.loadTimelineMonth(month.yearMonth)));
    await settle();
    expect(timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id)).toContain(removed.id);
    data.deleteAssets([removed.id], true);
    data.addAssets(added);
    eventManager.emit('WebsocketReconnect');
    await settle();
    await expect
      .poll(() => timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id))
      .toContain(added.id);

    const ids = timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id);
    expect(ids).not.toContain(removed.id);
    expect(ids).toContain(added.id);
    expect(ids).toContain(retained.id);
  } finally {
    timeline.destroy();
  }
});

test('failed reconnect refresh keeps the currently loaded photos', async ({ data, api, settle }) => {
  const asset = factory.asset();
  data.addAssets(asset);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await Promise.all(timeline.months.map((month) => timeline.loadTimelineMonth(month.yearMonth)));
    const before = timeline.months;
    api.on({ getTimeBuckets: () => ({ status: 503, json: { message: 'offline' } }) });
    eventManager.emit('WebsocketReconnect');
    await settle();
    expect(timeline.months).toEqual(before);
    expect(timeline.months.flatMap((month) => month.getAssets()).map((item) => item.id)).toContain(asset.id);
  } finally {
    timeline.destroy();
  }
});

test('an old reconnect response cannot repopulate a destroyed timeline', async ({ data, api }) => {
  data.addAssets(factory.asset());
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
  const before = timeline.months;
  let finish!: (value: { json: [] }) => void;
  api.on({ getTimeBuckets: () => new Promise((resolve) => (finish = resolve)) });
  const pending = timeline.refresh();
  await expect.poll(() => typeof finish).toBe('function');
  timeline.destroy();
  finish({ json: [] });
  await pending;
  expect(timeline.months).toEqual(before);
});

test('a newer reconnect retries when the previous refresh fails', async ({ data, api, settle }) => {
  const [removed, retained] = [factory.asset(), factory.asset()];
  data.addAssets([removed, retained]);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await Promise.all(timeline.months.map((month) => timeline.loadTimelineMonth(month.yearMonth)));
    let finish!: (value: { status: 503; json: { message: string } }) => void;
    api.on({ getTimeBuckets: () => new Promise((resolve) => (finish = resolve)) });
    eventManager.emit('WebsocketReconnect');
    await expect.poll(() => typeof finish).toBe('function');
    data.deleteAssets([removed.id], true);
    api.on({ getTimeBuckets: ({ params = {} }) => ({ json: data.timeBuckets(params) }) });
    eventManager.emit('WebsocketReconnect');
    finish({ status: 503, json: { message: 'previous connection failed' } });
    await settle();
    await expect
      .poll(() => timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id))
      .not.toContain(removed.id);
    await expect
      .poll(() => timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id))
      .toContain(retained.id);
  } finally {
    timeline.destroy();
  }
});

test('a failed month refresh preserves loaded photos and measured geometry', async ({ data, api, settle }) => {
  const asset = factory.asset();
  data.addAssets(asset);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await Promise.all(timeline.months.map((month) => timeline.loadTimelineMonth(month.yearMonth)));
    const month = timeline.months[0];
    const height = month.height;
    const calls = api.getTimeBucket.calls.length;
    api.on({ getTimeBucket: () => ({ status: 503, json: { message: 'offline month' } }) });
    eventManager.emit('WebsocketReconnect');
    await expect.poll(() => api.getTimeBucket.calls.length).toBeGreaterThan(calls);
    await settle();
    expect(timeline.months[0]).toBe(month);
    expect(month.height).toBe(height);
    expect(month.getAssets().map((item) => item.id)).toContain(asset.id);
  } finally {
    timeline.destroy();
  }
});

test('a detached noncancelable load cannot shift current months or add removed photos', async ({ data, api }) => {
  const old = factory.asset({ fileCreatedAt: '2025-01-02T00:00:00.000Z' });
  const retained = factory.asset({ fileCreatedAt: '2025-02-02T00:00:00.000Z' });
  data.addAssets([old, retained]);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    let finish!: () => void;
    api.on({
      getTimeBucket: ({ params }) => {
        const response = data.timeBucket(params.timeBucket, params);
        return params.timeBucket.startsWith('2025-01')
          ? new Promise((resolve) => (finish = () => resolve({ json: response })))
          : { json: response };
      },
    });
    const oldMonth = timeline.months.find((month) => month.yearMonth.month === 1)!;
    const pending = timeline.loadTimelineMonth(oldMonth.yearMonth, { cancelable: false });
    await expect.poll(() => typeof finish).toBe('function');
    data.deleteAssets([old.id], true);
    eventManager.emit('WebsocketReconnect');
    await expect.poll(() => timeline.months.length).toBe(1);
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await expect.poll(() => timeline.months[0].getAssets().map((item) => item.id)).toContain(retained.id);
    const top = timeline.months[0].top;
    finish();
    await pending;
    expect(timeline.months[0].top).toBe(top);
    expect(oldMonth.getAssets()).toEqual([]);
  } finally {
    timeline.destroy();
  }
});

test('a delayed refresh cannot resurrect a newer live deletion', async ({ data, api, settle }) => {
  const [removed, retained] = [
    factory.asset({ fileCreatedAt: '2025-01-02T00:00:00.000Z' }),
    factory.asset({ fileCreatedAt: '2025-01-03T00:00:00.000Z' }),
  ];
  data.addAssets([removed, retained]);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await Promise.all(timeline.months.map((month) => timeline.loadTimelineMonth(month.yearMonth)));
    let finish!: () => void;
    api.on({
      getTimeBucket: ({ params }) => {
        const response = data.timeBucket(params.timeBucket, params);
        return new Promise((resolve) => (finish = () => resolve({ json: response })));
      },
    });
    eventManager.emit('WebsocketReconnect');
    await expect.poll(() => typeof finish).toBe('function');
    data.deleteAssets([removed.id], true);
    timeline.removeAssets([removed.id]);
    finish();
    await settle();
    const ids = timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id);
    expect(ids).not.toContain(removed.id);
    expect(ids).toContain(retained.id);
  } finally {
    timeline.destroy();
  }
});

test('offscreen unloaded counts update reactively without fetching photos', async ({ data, api, settle }) => {
  const asset = factory.asset();
  data.addAssets(asset);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    const month = timeline.months[0];
    expect(month.assetsCount).toBe(1);
    expect(month.isLoaded).toBe(false);
    data.addAssets(factory.asset({ fileCreatedAt: asset.fileCreatedAt }));
    expect(data.timeBuckets({ visibility: AssetVisibility.Timeline })[0].count).toBe(2);
    eventManager.emit('WebsocketReconnect');
    await settle();
    await expect.poll(() => month.assetsCount).toBe(2);
    expect(timeline.months[0]).toBe(month);
    expect(month.assetsCount).toBe(2);
    expect(api.getTimeBucket).not.toHaveBeenCalled();
  } finally {
    timeline.destroy();
  }
});

test('reconnect removes stale album membership while keeping the photo available', async ({ data, settle }) => {
  const asset = factory.asset();
  const album = factory.album();
  data.addAssets(asset);
  data.addAlbums(album);
  data.addToAlbum(album.id, asset);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline, timelineAlbumId: album.id });
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await Promise.all(timeline.months.map((month) => timeline.loadTimelineMonth(month.yearMonth)));
    expect(timeline.albumAssets.has(asset.id)).toBe(true);
    data.removeFromAlbum(album.id, [asset.id]);
    eventManager.emit('WebsocketReconnect');
    await settle();
    await expect.poll(() => timeline.albumAssets.has(asset.id)).toBe(false);
    expect(timeline.months.flatMap((month) => month.getAssets()).map((item) => item.id)).toContain(asset.id);
  } finally {
    timeline.destroy();
  }
});

test('an old month list cannot discard a newly uploaded month', async ({ data, api }) => {
  data.addAssets(factory.asset({ fileCreatedAt: '2025-01-02T00:00:00.000Z' }));
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    let finish!: () => void;
    api.on({
      getTimeBuckets: ({ params = {} }) => {
        const response = data.timeBuckets(params);
        return new Promise((resolve) => (finish = () => resolve({ json: response })));
      },
    });
    const pending = timeline.refresh();
    await expect.poll(() => typeof finish).toBe('function');
    const uploaded = factory.asset({ fileCreatedAt: '2025-02-02T00:00:00.000Z' });
    data.addAssets(uploaded);
    timeline.upsertAssets([toTimelineAsset(uploaded)]);
    api.on({ getTimeBuckets: ({ params = {} }) => ({ json: data.timeBuckets(params) }) });
    finish();
    await pending;
    expect(timeline.months.flatMap((month) => month.getAssets()).map((item) => item.id)).toContain(uploaded.id);
    expect(timeline.months).toHaveLength(2);
  } finally {
    timeline.destroy();
  }
});

test('navigation awaiting an old month load also awaits the refreshed membership', async ({ data, api }) => {
  const removed = factory.asset({ fileCreatedAt: '2025-01-02T00:00:00.000Z' });
  const added = factory.asset({ fileCreatedAt: removed.fileCreatedAt });
  data.addAssets(removed);
  const timeline = new TimelineManager();
  eventManager.emit('WebsocketConnect');
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    const month = timeline.months[0];
    let finish!: () => void;
    api.on({
      getTimeBucket: ({ params }) => {
        const response = data.timeBucket(params.timeBucket, params);
        return new Promise((resolve) => (finish = () => resolve({ json: response })));
      },
    });
    const pending = timeline.loadTimelineMonth(month.yearMonth, { cancelable: false });
    await expect.poll(() => typeof finish).toBe('function');
    data.deleteAssets([removed.id], true);
    data.addAssets(added);
    api.on({ getTimeBucket: ({ params }) => ({ json: data.timeBucket(params.timeBucket, params) }) });
    await timeline.refresh();
    finish();
    await pending;
    expect(month.getAssets().map((item) => item.id)).toEqual([added.id]);
  } finally {
    timeline.destroy();
  }
});

test('the initial websocket connection does not restart an initialized timeline', async ({ data, api, settle }) => {
  data.addAssets(factory.asset());
  const timeline = new TimelineManager();
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    const calls = api.getTimeBuckets.calls.length;
    eventManager.emit('WebsocketConnect');
    await settle();
    expect(api.getTimeBuckets.calls).toHaveLength(calls);
  } finally {
    timeline.destroy();
  }
});

test('a timeline opened while disconnected refreshes on its first observed reconnect', async ({ data }) => {
  const [removed, retained] = [factory.asset(), factory.asset()];
  data.addAssets([removed, retained]);
  const timeline = new TimelineManager();
  try {
    await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
    await timeline.updateViewport({ width: 1440, height: 1000 });
    await Promise.all(timeline.months.map((month) => timeline.loadTimelineMonth(month.yearMonth)));
    data.deleteAssets([removed.id], true);
    eventManager.emit('WebsocketReconnect');
    await expect
      .poll(() => timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id))
      .not.toContain(removed.id);
    expect(timeline.months.flatMap((month) => month.getAssets()).map((asset) => asset.id)).toContain(retained.id);
  } finally {
    timeline.destroy();
  }
});
