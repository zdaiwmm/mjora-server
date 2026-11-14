import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { toISOYearMonthUTC } from '#lib/utils/timeline-util.ts';
import { getTimeBucket, type TimeBucketAssetResponseDto } from '@immich/sdk';
import { isEqual } from 'lodash-es';
import { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import type { TimelineManagerOptions } from '../types';

export async function loadFromTimeBuckets(
  timelineManager: TimelineManager,
  timelineMonth: TimelineMonth,
  options: TimelineManagerOptions,
  signal: AbortSignal,
  refresh = false,
  isCurrent = () => true,
): Promise<void> {
  const revision = timelineManager.assetChangeRevision;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const before = new Map($state.snapshot(timelineMonth.getAssets()).map((asset) => [asset.id, asset]));

  const timeBucket = toISOYearMonthUTC(timelineMonth.yearMonth);
  const bucketResponse = await getTimeBucket(
    {
      ...authManager.params,
      ...options,
      timeBucket,
    },
    { signal },
  );

  if (!bucketResponse || signal.aborted || !isCurrent() || !timelineManager.months.includes(timelineMonth)) {
    return;
  }

  if (options.timelineAlbumId) {
    const albumAssets = await getTimeBucket(
      {
        ...authManager.params,
        albumId: options.timelineAlbumId,
        timeBucket,
      },
      { signal },
    );
    if (!albumAssets || signal.aborted || !isCurrent() || !timelineManager.months.includes(timelineMonth)) {
      return;
    }
    timelineManager.setAlbumAssets(timelineMonth, albumAssets.id);
  }

  const current = $state.snapshot(timelineMonth.getAssets());
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const currentIds = new Set(current.map((asset) => asset.id));
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const removed = new Set([...before.keys()].filter((id) => !currentIds.has(id)));
  const newer = current.filter(
    (asset) => timelineManager.wasUpsertedAfter(asset.id, revision) || !isEqual(asset, before.get(asset.id)),
  );
  const keep = bucketResponse.id
    .map((_, index) => index)
    .filter(
      (index) =>
        !removed.has(bucketResponse.id[index]) &&
        !timelineManager.wasRemovedAfter(bucketResponse.id[index], revision) &&
        (refresh || !currentIds.has(bucketResponse.id[index])),
    );
  const response = (
    keep.length === bucketResponse.id.length
      ? bucketResponse
      : Object.fromEntries(
          Object.entries(bucketResponse).map(([key, values]) => [
            key,
            Array.isArray(values) ? keep.map((index) => values[index]) : values,
          ]),
        )
  ) as TimeBucketAssetResponseDto;
  if (refresh) {
    timelineMonth.timelineDays = [];
  }

  const unprocessedAssets = timelineMonth.addAssets(response, false);
  if (newer.length > 0) {
    timelineManager.upsertAssets(newer);
  }
  if (unprocessedAssets.length > 0) {
    console.error(
      `Warning: getTimeBucket API returning assets not in requested month: ${timelineMonth.yearMonth.month}, ${JSON.stringify(
        unprocessedAssets.map((unprocessed) => ({
          id: unprocessed.id,
          localDateTime: unprocessed.localDateTime,
        })),
      )}`,
    );
  }
}
