import { eventManager } from '#lib/managers/event-manager.svelte.ts';
import { TimelineManager } from '#lib/managers/timeline-manager/timeline-manager.svelte.ts';
import { websocketEvents } from '#lib/stores/websocket.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import { expect, vi } from 'vitest';

const setup = async () => {
  const listeners = new Map<string, (value: never) => void>();
  vi.spyOn(websocketEvents, 'on').mockImplementation((event, listener) => {
    listeners.set(event, listener as (value: never) => void);
    return () => void listeners.delete(event);
  });
  const timeline = new TimelineManager();
  await timeline.updateOptions({ visibility: AssetVisibility.Timeline });
  await timeline.updateViewport({ width: 1440, height: 1000 });
  vi.useFakeTimers();
  return {
    timeline,
    emit: (event: string, value: AssetResponseDto | string) => listeners.get(event)!(value as never),
    ids: () => timeline.months.flatMap((month) => month.getAssets().map((asset) => asset.id)),
    cleanup: () => {
      timeline.destroy();
      vi.useRealTimers();
      vi.restoreAllMocks();
    },
  };
};

test('disconnect cancels a trailing upload batch before the timeline changes owner or page', async () => {
  const context = await setup();
  try {
    const first = factory.asset();
    const trailing = factory.asset();
    context.emit('on_upload_success', first);
    context.emit('on_upload_success', trailing);
    expect(context.ids()).toEqual([first.id]);
    context.timeline.disconnect();
    await vi.advanceTimersByTimeAsync(3000);
    expect(context.ids()).toEqual([first.id]);
  } finally {
    context.cleanup();
  }
});

test('a stale asset update cannot roll a newer uploaded photo back to its previous day', async () => {
  const context = await setup();
  try {
    const older = factory.asset({ fileCreatedAt: '2025-06-10T12:00:00.000Z', updatedAt: '2025-06-10T12:00:00.000Z' });
    const newer = {
      ...older,
      fileCreatedAt: '2025-06-11T12:00:00.000Z',
      localDateTime: '2025-06-11T12:00:00.000Z',
      updatedAt: '2025-06-12T12:00:00.000Z',
    };
    context.emit('on_upload_success', newer);
    eventManager.emit('AssetUpdate', older);
    await vi.advanceTimersByTimeAsync(3000);
    expect(context.timeline.months[0].timelineDays.map((day) => day.day)).toEqual([11]);
    expect(context.ids()).toEqual([older.id]);
  } finally {
    context.cleanup();
  }
});

test('a live upload creates a scrubber month and replay keeps its count at one', async () => {
  const context = await setup();
  try {
    const uploaded = factory.asset({ fileCreatedAt: '2025-06-10T12:00:00.000Z' });
    context.emit('on_upload_success', uploaded);
    expect(context.timeline.scrubberMonths.map(({ year, month, assetCount }) => [year, month, assetCount])).toEqual([
      [2025, 6, 1],
    ]);
    context.emit('on_upload_success', uploaded);
    await vi.advanceTimersByTimeAsync(3000);
    expect(context.timeline.scrubberMonths.map(({ year, month, assetCount }) => [year, month, assetCount])).toEqual([
      [2025, 6, 1],
    ]);
  } finally {
    context.cleanup();
  }
});

test('a live upload and deletion update counts in an unloaded month without losing existing members', async ({
  data,
}) => {
  data.addAssets(
    Array.from({ length: 24 }, (_, month) =>
      factory.asset({ fileCreatedAt: new Date(Date.UTC(2024, month, 10)).toISOString() }),
    ),
  );
  const context = await setup();
  try {
    const month = context.timeline.months.find(({ yearMonth }) => yearMonth.year === 2024 && yearMonth.month === 1)!;
    expect(month.isLoaded).toBe(false);
    const uploaded = factory.asset({ fileCreatedAt: '2024-01-11T12:00:00.000Z' });
    context.emit('on_upload_success', uploaded);
    expect(month.assetsCount).toBe(2);
    context.emit('on_upload_success', uploaded);
    await vi.advanceTimersByTimeAsync(3000);
    expect(month.assetsCount).toBe(2);
    context.emit('on_asset_delete', uploaded.id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(month.assetsCount).toBe(1);
    expect(month.timelineDays).toHaveLength(0);
  } finally {
    context.cleanup();
  }
});
