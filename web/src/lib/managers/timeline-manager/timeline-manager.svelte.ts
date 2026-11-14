import { VirtualScrollManager } from '#lib/managers/VirtualScrollManager/VirtualScrollManager.svelte.ts';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { eventManager } from '#lib/managers/event-manager.svelte.ts';
import { GroupInsertionCache } from '#lib/managers/timeline-manager/group-insertion-cache.svelte.ts';
import { updateTimelineMonthViewportProximity } from '#lib/managers/timeline-manager/internal/intersection-support.svelte.ts';
import { updateGeometry } from '#lib/managers/timeline-manager/internal/layout-support.svelte.ts';
import { loadFromTimeBuckets } from '#lib/managers/timeline-manager/internal/load-support.svelte.ts';
import {
  findClosestTimelineMonthForDate,
  findTimelineMonthForAsset as findTimelineMonthForAssetUtil,
  findTimelineMonthForDate,
  getAssetWithOffset,
  getTimelineMonthByDate,
  retrieveRange as retrieveRangeUtil,
} from '#lib/managers/timeline-manager/internal/search-support.svelte.ts';
import { WebsocketSupport } from '#lib/managers/timeline-manager/internal/websocket-support.svelte.ts';
import { userPreferencesManager } from '#lib/managers/user-preferences-manager.svelte.ts';
import { updateStackedAssetInTimeline } from '#lib/utils/actions.ts';
import { CancellableTask } from '#lib/utils/cancellable-task.ts';
import {
  getOrderingDate,
  isAssetResponseDto,
  setDifference,
  toTimelineAsset,
  type TimelineDateTime,
  type TimelineYearMonth,
} from '#lib/utils/timeline-util.ts';
import {
  AssetOrder,
  AssetOrderBy,
  AssetVisibility,
  getAssetInfo,
  getTimeBuckets,
  type AssetResponseDto,
  type TimeBucketsResponseDto,
} from '@immich/sdk';
import { clamp, isEqual } from 'lodash-es';
import { SvelteDate, SvelteSet } from 'svelte/reactivity';
import { isMismatched, updateObject } from './internal/utils.svelte';
import { TimelineDay } from './timeline-day.svelte';
import { TimelineMonth } from './timeline-month.svelte';
import type {
  AssetDescriptor,
  Direction,
  MoveAsset,
  ScrubberMonth,
  TimelineAsset,
  TimelineManagerOptions,
  Viewport,
} from './types';

type ViewportTopMonthIntersection = {
  month: TimelineMonth | undefined;
  // Where viewport top intersects month (0 = month top, 1 = month bottom)
  viewportTopRatioInMonth: number;
  // Where month bottom is in viewport (0 = viewport top, 1 = viewport bottom)
  monthBottomViewportRatio: number;
};
export class TimelineManager extends VirtualScrollManager {
  override bottomSectionHeight = $state(60);

  override bodySectionHeight = $derived.by(() => {
    let height = 0;
    for (const month of this.months) {
      height += month.height;
    }
    return height;
  });

  assetCount = $derived.by(() => {
    let count = 0;
    for (const month of this.months) {
      count += month.assetsCount;
    }
    return count;
  });

  isInitialized = $state(false);
  isScrollingOnLoad = false;
  months: TimelineMonth[] = $state([]);
  albumAssets: Set<string> = new SvelteSet();
  scrubberMonths: ScrubberMonth[] = $state([]);
  scrubberTimelineHeight: number = $state(0);
  viewportTopMonthIntersection: ViewportTopMonthIntersection | undefined;
  limitedScroll = $derived(this.maxScrollPercent < 0.5);
  initTask = new CancellableTask(
    () => {
      this.isInitialized = true;
      if (this.#options.albumId || this.#options.personId) {
        return;
      }
      this.connect();
    },
    () => {
      this.disconnect();
      this.isInitialized = false;
    },
    () => void 0,
  );

  static #INIT_OPTIONS = {};
  #websocketSupport: WebsocketSupport | undefined;
  #options: TimelineManagerOptions = TimelineManager.#INIT_OPTIONS;
  #updatingViewportProximities = false;
  #scrollableElement: HTMLElement | undefined = $state();
  #unsubscribes: Array<() => void> = [];
  #generation = 0;
  #destroyed = false;
  #refreshTask: Promise<void> | undefined;
  #refreshAgain = false;
  #refreshController: AbortController | undefined;
  #refreshRevision = 0;
  // Request bookkeeping is deliberately nonreactive; only timeline state drives rendering.
  /* eslint-disable svelte/prefer-svelte-reactivity */
  #staleMonths = new Set<TimelineMonth>();
  #monthRefreshTasks = new Map<TimelineMonth, { revision: number; controller: AbortController; task: Promise<void> }>();
  #assetChangeRevision = 0;
  #removedAt = new Map<string, number>();
  #upsertedAt = new Map<string, number>();
  #assetVersions = new Map<string, number>();
  #albumAssetsByMonth = new Map<TimelineMonth, Set<string>>();
  /* eslint-enable svelte/prefer-svelte-reactivity */

  get assetChangeRevision() {
    return this.#assetChangeRevision;
  }

  wasRemovedAfter(id: string, revision: number) {
    const removed = this.#removedAt.get(id) ?? 0;
    return removed > revision && removed > (this.#upsertedAt.get(id) ?? 0);
  }

  wasUpsertedAfter(id: string, revision: number) {
    return (this.#upsertedAt.get(id) ?? 0) > revision;
  }

  #recordUpserts(assets: TimelineAsset[]) {
    const revision = ++this.#assetChangeRevision;
    for (const asset of assets) {
      if (this.isExcluded(asset)) {
        continue;
      }
      this.#upsertedAt.set(asset.id, revision);
      if (asset.updatedAt) {
        this.#assetVersions.set(asset.id, Date.parse(asset.updatedAt));
      }
    }
  }

  setAlbumAssets(month: TimelineMonth, ids: string[]) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    this.#albumAssetsByMonth.set(month, new Set(ids));
    this.#rebuildAlbumAssets();
  }

  #rebuildAlbumAssets() {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const ids = new Set<string>();
    for (const values of this.#albumAssetsByMonth.values()) {
      for (const id of values) {
        ids.add(id);
      }
    }
    for (const id of this.albumAssets) {
      if (!ids.has(id)) {
        this.albumAssets.delete(id);
      }
    }
    for (const id of ids) {
      this.albumAssets.add(id);
    }
  }

  get showAssetOwners() {
    return userPreferencesManager.showAssetOwners;
  }

  setShowAssetOwners(value: boolean) {
    userPreferencesManager.showAssetOwners = value;
  }

  toggleShowAssetOwners() {
    userPreferencesManager.showAssetOwners = !userPreferencesManager.showAssetOwners;
  }

  constructor() {
    super();

    this.#unsubscribes.push(
      eventManager.on({
        WebsocketReconnect: () => this.refresh().catch(() => {}),
        AssetUpdate: (asset: AssetResponseDto) => {
          const timelineAsset = toTimelineAsset(asset);
          this.upsertAssetsFromLiveEvent([timelineAsset]);
        },
        AssetsArchive: (assetIds) => this.update(assetIds, (asset) => (asset.visibility = AssetVisibility.Archive)),
        AssetsUnarchive: (assets) => {
          if (this.#options.visibility === AssetVisibility.Archive) {
            this.removeAssets(assets.map((asset) => asset.id));
          } else {
            this.upsertAssets(assets);
          }
        },
        AlbumRemoveAssets: ({ assetIds, albumIds }) => {
          if (this.#options.albumId && albumIds.includes(this.#options.albumId)) {
            this.removeAssets(assetIds);
          }
        },
        StackCreate: (stack) => {
          if (this.#options.withStacked) {
            updateStackedAssetInTimeline(this, stack);
          }
        },
        StackDelete: ({ assets }) => {
          if (!this.#options.withStacked) {
            return;
          }
          this.update(
            assets.map((asset) => asset.id),
            (asset) => (asset.stack = null),
          );
          this.upsertAssets(assets.map((asset) => toTimelineAsset(asset)));
        },
        StackUpdate: (stack) => {
          if (!this.#options.withStacked) {
            return;
          }
          // unstack and re-stack
          this.update(
            stack.assets.map((asset) => asset.id),
            (asset) => (asset.stack = null),
          );
          this.upsertAssets(stack.assets.map((asset) => toTimelineAsset(asset)));
          updateStackedAssetInTimeline(this, stack);
        },
      }),
    );
  }

  override get scrollTop(): number {
    return this.#scrollableElement?.scrollTop ?? 0;
  }

  set scrollableElement(element: HTMLElement | undefined) {
    this.#scrollableElement = element;
  }

  scrollTo(top: number) {
    this.#scrollableElement?.scrollTo({ top });
    this.updateSlidingWindow();
  }

  scrollBy(y: number) {
    this.#scrollableElement?.scrollBy(0, y);
    this.updateSlidingWindow();
  }

  async *assetsIterator(options?: {
    startTimelineMonth?: TimelineMonth;
    startTimelineDay?: TimelineDay;
    startAsset?: TimelineAsset;
    direction?: Direction;
  }) {
    const direction = options?.direction ?? 'earlier';
    let { startTimelineDay, startAsset } = options ?? {};
    for (const timelineMonth of this.timelineMonthIterator({
      direction,
      startTimelineMonth: options?.startTimelineMonth,
    })) {
      await this.loadTimelineMonth(timelineMonth.yearMonth, { cancelable: false });
      yield* timelineMonth.assetsIterator({ startTimelineDay, startAsset, direction });
      startTimelineDay = startAsset = undefined;
    }
  }

  *timelineMonthIterator(options?: { direction?: Direction; startTimelineMonth?: TimelineMonth }) {
    const isEarlier = options?.direction === 'earlier';
    let startIndex = options?.startTimelineMonth
      ? this.months.indexOf(options.startTimelineMonth)
      : isEarlier
        ? 0
        : this.months.length - 1;

    while (startIndex >= 0 && startIndex < this.months.length) {
      yield this.months[startIndex];
      startIndex += isEarlier ? 1 : -1;
    }
  }

  connect() {
    if (this.#websocketSupport) {
      throw new Error('TimelineManager already connected');
    }
    this.#websocketSupport = new WebsocketSupport(this);
    this.#websocketSupport.connectWebsocketEvents();
  }

  disconnect() {
    if (!this.#websocketSupport) {
      return;
    }
    this.#websocketSupport.disconnectWebsocketEvents();
    this.#websocketSupport = undefined;
  }

  #calculateMonthBottomViewportRatio(month: TimelineMonth | undefined) {
    if (!month) {
      return 0;
    }
    const windowHeight = this.visibleWindow.bottom - this.visibleWindow.top;
    const bottomOfMonth = month.top + month.height;
    const bottomOfMonthInViewport = bottomOfMonth - this.visibleWindow.top;
    return clamp(bottomOfMonthInViewport / windowHeight, 0, 1);
  }

  #calculateVewportTopRatioInMonth(month: TimelineMonth | undefined) {
    if (!month) {
      return 0;
    }
    return clamp((this.visibleWindow.top - month.top) / month.height, 0, 1);
  }

  override updateViewportProximities() {
    if (
      this.#updatingViewportProximities ||
      !this.isInitialized ||
      this.visibleWindow.bottom === this.visibleWindow.top
    ) {
      return;
    }
    this.#updatingViewportProximities = true;

    for (const month of this.months) {
      updateTimelineMonthViewportProximity(this, month);
      if (month.isInOrNearViewport && month.isLoaded) {
        for (const day of month.timelineDays) {
          day.updateAssetBoundaries();
        }
      }
    }

    const month = this.months.find((month) => month.isInViewport);
    const viewportTopRatioInMonth = this.#calculateVewportTopRatioInMonth(month);
    const monthBottomViewportRatio = this.#calculateMonthBottomViewportRatio(month);

    this.viewportTopMonthIntersection = {
      month,
      monthBottomViewportRatio,
      viewportTopRatioInMonth,
    };

    this.#updatingViewportProximities = false;
  }

  clearDeferredLayout(month: TimelineMonth) {
    const hasDeferred = month.timelineDays.some((group) => group.deferredLayout);
    if (hasDeferred) {
      updateGeometry(this, month, { invalidateHeight: true, noDefer: true });
      for (const group of month.timelineDays) {
        group.deferredLayout = false;
      }
    }
  }

  async #initializeTimelineMonths() {
    const timebuckets = await getTimeBuckets({
      ...authManager.params,
      ...this.#options,
    });

    this.#replaceTimelineMonths(timebuckets);
  }

  #replaceTimelineMonths(timebuckets: TimeBucketsResponseDto[]) {
    for (const month of this.months) {
      month.cancel();
    }
    this.months = timebuckets.map((timeBucket) => {
      const date = new SvelteDate(timeBucket.timeBucket);
      return new TimelineMonth(
        this,
        { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 },
        timeBucket.count,
        false,
        this.#options.order,
        this.#options.orderBy,
      );
    });
    this.albumAssets.clear();
    this.#albumAssetsByMonth.clear();
    this.updateViewportGeometry(false);
  }

  // Reconnect cannot replay events missed while offline. Counts alone also
  // miss a deletion balanced by an upload, so visible membership reloads.
  async refresh() {
    if (this.#destroyed || !this.isInitialized) {
      return;
    }
    if (this.#refreshTask) {
      this.#refreshAgain = true;
      this.#refreshController?.abort();
      for (const { controller } of this.#monthRefreshTasks.values()) {
        controller.abort();
      }
      return this.#refreshTask;
    }
    const task = (async () => {
      do {
        this.#refreshAgain = false;
        const generation = this.#generation;
        const assetRevision = this.#assetChangeRevision;
        const options = this.#options;
        const controller = (this.#refreshController = new AbortController());
        try {
          const timebuckets = await getTimeBuckets(
            { ...authManager.params, ...options },
            { signal: controller.signal },
          );
          if (this.#destroyed || generation !== this.#generation || this.#refreshAgain) {
            continue;
          }
          if (assetRevision !== this.#assetChangeRevision) {
            // A live change may have created a month absent from this snapshot.
            this.#refreshAgain = true;
            continue;
          }
          // eslint-disable-next-line svelte/prefer-svelte-reactivity
          const previous = new Map(this.months.map((month) => [month.viewId, month]));
          this.#refreshRevision++;
          this.months = timebuckets.map((bucket) => {
            const date = new SvelteDate(bucket.timeBucket);
            const yearMonth = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
            const existing = previous.get(`${yearMonth.year}-${yearMonth.month}`);
            if (existing) {
              previous.delete(existing.viewId);
              existing.updateInitialCount(bucket.count);
              this.#staleMonths.add(existing);
              return existing;
            }
            return new TimelineMonth(this, yearMonth, bucket.count, false, options.order, options.orderBy);
          });
          for (const month of previous.values()) {
            month.cancel();
            this.#staleMonths.delete(month);
            this.#monthRefreshTasks.get(month)?.controller.abort();
            this.#albumAssetsByMonth.delete(month);
          }
          this.#rebuildAlbumAssets();
          this.updateViewportGeometry(false);
          await Promise.all(
            this.months
              .filter((month) => month.isInOrNearViewport)
              .map((month) => this.loadTimelineMonth(month.yearMonth)),
          );
          this.#createScrubberMonths();
        } catch (error) {
          if (!this.#refreshAgain && !this.#destroyed) {
            throw error;
          }
        }
      } while (this.#refreshAgain && !this.#destroyed && this.isInitialized);
    })();
    this.#refreshTask = task;
    try {
      await task;
    } finally {
      if (this.#refreshTask === task) {
        this.#refreshTask = undefined;
      }
    }
  }

  async updateOptions(options: TimelineManagerOptions) {
    if (options.deferInit) {
      return;
    }
    if (this.#options !== TimelineManager.#INIT_OPTIONS && isEqual(this.#options, options)) {
      return;
    }

    this.suspendTransitions = true;
    try {
      await this.initTask.reset();
      await this.#init(options);
      this.updateViewportGeometry(false);
      this.#createScrubberMonths();
    } finally {
      this.suspendTransitions = false;
    }
  }

  async #init(options: TimelineManagerOptions) {
    this.#generation++;
    this.#removedAt.clear();
    this.#upsertedAt.clear();
    this.#assetVersions.clear();
    this.#staleMonths.clear();
    for (const { controller } of this.#monthRefreshTasks.values()) {
      controller.abort();
    }
    this.isInitialized = false;
    this.months = [];
    this.albumAssets.clear();
    await this.initTask.execute(async () => {
      this.#options = options;
      await this.#initializeTimelineMonths();
    }, true);
  }

  public override destroy() {
    this.#destroyed = true;
    this.#generation++;
    this.#refreshController?.abort();
    for (const { controller } of this.#monthRefreshTasks.values()) {
      controller.abort();
    }
    this.disconnect();
    this.isInitialized = false;

    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe();
    }

    super.destroy();
  }

  async updateViewport(viewport: Viewport) {
    if (viewport.height === 0 && viewport.width === 0) {
      return;
    }

    if (this.viewportHeight === viewport.height && this.viewportWidth === viewport.width) {
      return;
    }

    if (!this.initTask.executed) {
      await (this.initTask.loading ? this.initTask.waitUntilCompletion() : this.#init(this.#options));
    }

    const changedWidth = viewport.width !== this.viewportWidth;
    this.viewportHeight = viewport.height;
    this.viewportWidth = viewport.width;
    this.updateViewportGeometry(changedWidth);
  }

  protected override updateViewportGeometry(changedWidth: boolean) {
    if (!this.isInitialized || this.hasEmptyViewport) {
      return;
    }
    for (const month of this.months) {
      updateGeometry(this, month, { invalidateHeight: changedWidth });
    }
    this.updateViewportProximities();
    if (changedWidth) {
      this.#createScrubberMonths();
    }
  }

  #createScrubberMonths() {
    this.scrubberMonths = this.months.map((month) => ({
      assetCount: month.assetsCount,
      year: month.yearMonth.year,
      month: month.yearMonth.month,
      title: month.title,
      height: month.height,
    }));
    this.scrubberTimelineHeight = this.totalViewerHeight;
  }

  async loadTimelineMonth(yearMonth: TimelineYearMonth, options?: { cancelable: boolean }): Promise<void> {
    const cancelable = options?.cancelable ?? true;
    const timelineMonth = getTimelineMonthByDate(this, yearMonth);
    if (!timelineMonth) {
      return;
    }

    const generation = this.#generation;
    const revision = this.#refreshRevision;
    const isCurrent = () =>
      !this.#destroyed &&
      generation === this.#generation &&
      revision === this.#refreshRevision &&
      this.months.includes(timelineMonth);
    if (this.#staleMonths.has(timelineMonth)) {
      const existing = this.#monthRefreshTasks.get(timelineMonth);
      if (existing?.revision === revision) {
        return existing.task;
      }
      existing?.controller.abort();
      const controller = new AbortController();
      const task = (async () => {
        try {
          await loadFromTimeBuckets(this, timelineMonth, this.#options, controller.signal, true, isCurrent);
          if (!isCurrent() || controller.signal.aborted) {
            return;
          }
          timelineMonth.isLoaded = true;
          this.#staleMonths.delete(timelineMonth);
          updateGeometry(this, timelineMonth, { invalidateHeight: false });
          this.updateViewportProximities();
        } catch {
          // Retain loaded assets and geometry; a later refresh/scroll retries.
        } finally {
          if (this.#monthRefreshTasks.get(timelineMonth)?.controller === controller) {
            this.#monthRefreshTasks.delete(timelineMonth);
          }
        }
      })();
      this.#monthRefreshTasks.set(timelineMonth, { revision, controller, task });
      return task;
    }

    if (timelineMonth.isLoaded || timelineMonth.loader?.executed) {
      return;
    }

    const executionStatus = await timelineMonth.loader?.execute(async (signal: AbortSignal) => {
      try {
        await loadFromTimeBuckets(this, timelineMonth, this.#options, signal, false, isCurrent);
      } catch (error) {
        if (isCurrent()) {
          throw error;
        }
      }
    }, cancelable);
    if (
      generation === this.#generation &&
      this.months.includes(timelineMonth) &&
      this.#staleMonths.has(timelineMonth)
    ) {
      // A reconnect invalidated this request while navigation was awaiting it.
      return this.loadTimelineMonth(yearMonth, options);
    }
    if (executionStatus === 'LOADED' && isCurrent()) {
      updateGeometry(this, timelineMonth, { invalidateHeight: false });
      this.updateViewportProximities();
    }
  }

  upsertAssets(assets: TimelineAsset[]) {
    this.#recordUpserts(assets);
    const notUpdated = this.#updateAssets(assets);
    const notExcluded = notUpdated.filter((asset) => !this.isExcluded(asset));
    this.addAssetsUpsertSegments([...notExcluded]);
  }

  upsertAssetsFromLiveEvent(assets: TimelineAsset[]) {
    // A delete has no server version. Only an explicit restore/upsert may lift
    // its tombstone; a delayed upload notification cannot recreate the photo.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const current = new Map<string, TimelineAsset>();
    for (const asset of assets) {
      const version = asset.updatedAt ? Date.parse(asset.updatedAt) : undefined;
      const latest = this.#assetVersions.get(asset.id);
      if (this.wasRemovedAfter(asset.id, 0) || (version !== undefined && latest !== undefined && version < latest)) {
        continue;
      }
      if (version !== undefined) {
        this.#assetVersions.set(asset.id, version);
      }
      current.set(asset.id, asset);
    }
    const accepted = [...current.values()];
    if (accepted.length === 0) {
      return;
    }
    this.#recordUpserts(accepted);
    const notUpdated = this.#updateAssets(accepted);
    const insertable = notUpdated.filter((asset) => this.canInsertAssetFromLiveEvent(asset));
    this.addAssetsUpsertSegments(insertable);
  }

  async findTimelineMonthForAsset(asset: AssetDescriptor | AssetResponseDto) {
    if (!this.isInitialized) {
      await this.initTask.waitUntilExecution();
    }

    const { id } = asset;
    let { timelineMonth } = findTimelineMonthForAssetUtil(this, id) ?? {};
    if (timelineMonth) {
      return timelineMonth;
    }

    const response = isAssetResponseDto(asset)
      ? asset
      : await getAssetInfo({ ...authManager.params, id }).catch(() => null);
    if (!response) {
      return;
    }

    const timelineAsset = toTimelineAsset(response);
    if (this.isExcluded(timelineAsset)) {
      return;
    }

    timelineMonth = await this.#loadTimelineMonthAtTime(
      getOrderingDate(timelineAsset, this.#options.orderBy || AssetOrderBy.TakenAt),
      { cancelable: false },
    );
    if (timelineMonth?.findAssetById({ id })) {
      return timelineMonth;
    }
  }

  async #loadTimelineMonthAtTime(yearMonth: TimelineYearMonth, options?: { cancelable: boolean }) {
    await this.loadTimelineMonth(yearMonth, options);
    return getTimelineMonthByDate(this, yearMonth);
  }

  getTimelineMonthByAssetId(assetId: string) {
    const timelineMonthInfo = findTimelineMonthForAssetUtil(this, assetId);
    return timelineMonthInfo?.timelineMonth;
  }

  // note: the `index` input is expected to be in the range [0, assetCount). This
  // value can be passed to make the method deterministic, which is mainly useful
  // for testing.
  async getRandomAsset(index?: number): Promise<TimelineAsset | undefined> {
    const randomAssetIndex = index ?? Math.floor(Math.random() * this.assetCount);

    let accumulatedCount = 0;

    let randomMonth: TimelineMonth | undefined = undefined;
    for (const month of this.months) {
      if (randomAssetIndex < accumulatedCount + month.assetsCount) {
        randomMonth = month;
        break;
      }

      accumulatedCount += month.assetsCount;
    }
    if (!randomMonth) {
      return;
    }
    await this.loadTimelineMonth(randomMonth.yearMonth, { cancelable: false });

    let randomDay: TimelineDay | undefined = undefined;
    for (const day of randomMonth.timelineDays) {
      if (randomAssetIndex < accumulatedCount + day.viewerAssets.length) {
        randomDay = day;
        break;
      }

      accumulatedCount += day.viewerAssets.length;
    }
    if (!randomDay) {
      return;
    }

    return randomDay.viewerAssets[randomAssetIndex - accumulatedCount].asset;
  }

  /** Executes callback on assets, handling moves between groups and removals due to filter criteria. */
  update(ids: string[], callback: (asset: TimelineAsset) => void) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    return this.#runAssetCallback(new Set(ids), callback);
  }

  removeAssets(ids: string[]) {
    const revision = ++this.#assetChangeRevision;
    for (const id of ids) {
      this.#removedAt.set(id, revision);
    }
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const result = this.#runAssetCallback(new Set(ids), () => ({ remove: true }));
    return [...result.notUpdated];
  }

  protected upsertSegmentForAsset(asset: TimelineAsset) {
    const dateTime = getOrderingDate(asset, this.#options.orderBy || AssetOrderBy.TakenAt);
    let month = getTimelineMonthByDate(this, dateTime);

    if (!month) {
      month = new TimelineMonth(this, dateTime, 1, true, this.#options.order, this.#options.orderBy);
      this.months.push(month);
    } else if (!month.isLoaded) {
      month.updateInitialCount(month.assetsCount + 1);
    }
    return month;
  }

  /**
  Adds assets to existing segments, creating new segments as needed.
  
  This is an internal method that assumes the provided assets are not already
  present in the timeline. For updating existing assets, use updateAssetOperation().
  */
  protected addAssetsUpsertSegments(assets: TimelineAsset[]) {
    if (assets.length === 0) {
      return;
    }
    const context = new GroupInsertionCache();
    const monthCount = this.months.length;
    for (const asset of assets) {
      this.upsertSegmentForAsset(asset).addTimelineAsset(asset, context);
    }
    if (this.months.length !== monthCount) {
      this.postCreateSegments();
    }
    this.postUpsert(context);
  }

  #updateAssets(assets: TimelineAsset[]) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const cache = new Map<string, TimelineAsset>(assets.map((asset) => [asset.id, asset]));
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const idsToUpdate = new Set(cache.keys());
    const result = this.#runAssetCallback(idsToUpdate, (asset) => void updateObject(asset, cache.get(asset.id)));
    const notUpdated: TimelineAsset[] = Array.from(result.notUpdated, (assetId) => cache.get(assetId)!);
    return notUpdated;
  }

  #runAssetCallback(ids: Set<string>, callback: (asset: TimelineAsset) => void | { remove?: boolean }) {
    if (ids.size === 0) {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      return { updated: new Set<string>(), notUpdated: ids, changedGeometry: false };
    }
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const changedTimelineMonths = new Set<TimelineMonth>();
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    let notUpdated = new Set(ids);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const updated = new Set<string>();
    const assetsToMoveSegments: MoveAsset[][] = [];
    for (const month of this.months) {
      if (notUpdated.size === 0) {
        break;
      }
      const previousCount = month.isLoaded ? 0 : month.getAssets().length;
      const result = month.runAssetCallback(notUpdated, callback);
      if (!month.isLoaded && result.changedGeometry) {
        month.updateInitialCount(month.assetsCount + month.getAssets().length - previousCount);
      }
      if (result.moveAssets.length > 0) {
        assetsToMoveSegments.push(result.moveAssets);
      }
      if (result.changedGeometry) {
        changedTimelineMonths.add(month);
      }
      notUpdated = setDifference(notUpdated, result.processedIds);
      for (const id of result.processedIds) {
        updated.add(id);
      }
    }
    const assetsToAdd = [];
    for (const segment of assetsToMoveSegments) {
      for (const moveAsset of segment) {
        assetsToAdd.push(moveAsset.asset);
      }
    }
    this.addAssetsUpsertSegments(assetsToAdd);
    const changedGeometry = changedTimelineMonths.size > 0;
    for (const month of changedTimelineMonths) {
      updateGeometry(this, month, { invalidateHeight: true });
    }
    if (changedGeometry) {
      this.updateViewportProximities();
      this.#createScrubberMonths();
    }
    return { updated, notUpdated, changedGeometry };
  }

  override refreshLayout() {
    for (const month of this.months) {
      updateGeometry(this, month, { invalidateHeight: true });
    }
    this.updateViewportProximities();
  }

  getFirstAsset(): TimelineAsset | undefined {
    return this.months[0]?.getFirstAsset();
  }

  async getLaterAsset(
    assetDescriptor: AssetDescriptor | AssetResponseDto,
    interval: 'asset' | 'day' | 'month' | 'year' = 'asset',
  ): Promise<TimelineAsset | undefined> {
    return await getAssetWithOffset(this, assetDescriptor, interval, 'later');
  }

  async getEarlierAsset(
    assetDescriptor: AssetDescriptor | AssetResponseDto,
    interval: 'asset' | 'day' | 'month' | 'year' = 'asset',
  ): Promise<TimelineAsset | undefined> {
    return await getAssetWithOffset(this, assetDescriptor, interval, 'earlier');
  }

  async getClosestAssetToDate(dateTime: TimelineDateTime) {
    let timelineMonth = findTimelineMonthForDate(this, dateTime);
    if (!timelineMonth) {
      // if exact match not found, find closest
      timelineMonth = findClosestTimelineMonthForDate(this.months, dateTime);
      if (!timelineMonth) {
        return;
      }
    }
    await this.loadTimelineMonth(dateTime, { cancelable: false });
    const asset = timelineMonth.findClosest(dateTime);
    if (asset) {
      return asset;
    }
    for await (const asset of this.assetsIterator({ startTimelineMonth: timelineMonth })) {
      return asset;
    }
  }

  async retrieveRange(start: AssetDescriptor, end: AssetDescriptor) {
    return retrieveRangeUtil(this, start, end);
  }

  isExcluded(asset: TimelineAsset) {
    return (
      isMismatched(this.#options.visibility, asset.visibility) ||
      isMismatched(this.#options.isFavorite, asset.isFavorite) ||
      isMismatched(this.#options.isTrashed, asset.isTrashed) ||
      (this.#options.tagId && asset.tags && !asset.tags.includes(this.#options.tagId)) ||
      (this.#options.assetFilter !== undefined && !this.#options.assetFilter.has(asset.id))
    );
  }

  canInsertAssetFromLiveEvent(asset: TimelineAsset) {
    if (this.isExcluded(asset)) {
      return false;
    }
    if (this.#options.albumId || this.#options.personId || this.#options.timelineAlbumId) {
      return false;
    }
    if (this.#options.userId && !this.#options.withPartners && asset.ownerId !== this.#options.userId) {
      return false;
    }
    return true;
  }

  getAssetOrder() {
    return this.#options.order ?? AssetOrder.Desc;
  }

  getOrderBy() {
    return this.#options.orderBy ?? AssetOrderBy.TakenAt;
  }

  protected postCreateSegments(): void {
    this.months.sort((a, b) => {
      return a.yearMonth.year === b.yearMonth.year
        ? b.yearMonth.month - a.yearMonth.month
        : b.yearMonth.year - a.yearMonth.year;
    });
  }

  protected postUpsert(context: GroupInsertionCache): void {
    for (const group of context.existingTimelineDays) {
      group.sortAssets(this.#options.order);
    }

    for (const timelineMonth of context.bucketsWithNewTimelineDays) {
      timelineMonth.sortTimelineDays();
    }

    for (const month of context.updatedBuckets) {
      month.sortTimelineDays();
      updateGeometry(this, month, { invalidateHeight: true });
    }
    this.updateViewportProximities();
    this.#createScrubberMonths();
  }
}
