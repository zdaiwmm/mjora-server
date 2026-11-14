import { Route } from '#lib/route.ts';
import { factory } from '#test/common/factories.ts';
import { placeholderImage } from '#test/common/helpers.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { AssetMediaSize } from '@immich/sdk';

test.describe('broken asset', () => {
  test('a live upload with a missing thumbnail stays clickable and can retry its thumbnail', async ({
    page,
    data,
    api,
    logger,
    app,
  }) => {
    const old = factory.asset({ fileCreatedAt: '2025-06-10T12:00:00.000Z' });
    const uploaded = factory.asset({ fileCreatedAt: '2025-06-11T12:00:00.000Z' });
    let missingThumbnail = true;
    api.on({
      viewAsset: ({ params }) =>
        params.id === uploaded.id && params.size === AssetMediaSize.Thumbnail && missingThumbnail
          ? { status: 404, headers: { 'cache-control': 'private, max-age=86400' } }
          : { body: placeholderImage(data.getAsset(params.id), params.id), contentType: 'image/svg+xml' },
    });
    data.addAssets(old);
    await page.goto(Route.photos());
    await expect(app.timeline.thumbnail(old)).toBeVisible();
    data.addAssets(uploaded);
    const initialRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === `/api/assets/${uploaded.id}/thumbnail` &&
        url.searchParams.get('size') === AssetMediaSize.Thumbnail
      );
    });
    await api.emitAndWait('on_upload_success', uploaded);
    const initialThumbnailRequest = await initialRequest;
    const initialUrl = initialThumbnailRequest.url();
    const thumbnail = app.timeline.thumbnail(uploaded);
    await expect(thumbnail.getByTestId('broken-asset')).toBeVisible();
    await expect(thumbnail.getByRole('button', { name: 'retry', exact: true })).toBeVisible();
    await thumbnail.click();
    await app.viewer.waitForAsset(uploaded);
    await app.viewer.backButton.click();
    await page.waitForURL(/\/photos\?at=/);
    await expect(app.viewer.root).toHaveCount(0);
    missingThumbnail = false;
    const retryRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === `/api/assets/${uploaded.id}/thumbnail` &&
        url.searchParams.get('size') === AssetMediaSize.Thumbnail
      );
    });
    await thumbnail.getByRole('button', { name: 'retry', exact: true }).focus();
    await page.keyboard.press('Enter');
    const retryThumbnailRequest = await retryRequest;
    const retryUrl = retryThumbnailRequest.url();
    expect(retryUrl).not.toBe(initialUrl);
    expect(new URL(initialUrl).searchParams.get('c')).toBe(uploaded.thumbhash);
    await expect(app.viewer.root).toHaveCount(0);
    await expect(thumbnail.getByTestId('broken-asset')).toHaveCount(0);
    await expect
      .poll(() => thumbnail.locator('img').evaluate((element) => element.complete && element.naturalWidth > 0))
      .toBe(true);
    for (const asset of [uploaded, old, uploaded]) {
      await app.timeline.thumbnail(asset).click();
      await app.viewer.waitForAsset(asset);
      await app.viewer.backButton.click();
      await page.waitForURL(/\/photos\?at=/);
      await expect(app.viewer.root).toHaveCount(0);
    }
    expect(logger.error).toHaveBeenCalledWith(/404/);
  });

  test('stack strip shows the message without an icon', async ({ page, data, logger, app }) => {
    const [primary, ...broken] = [factory.asset(), factory.asset(), factory.asset(), factory.asset()];
    data.addStacks(factory.stack({ assets: [primary, ...broken] })).markBroken(broken);
    await page.goto(Route.viewAsset({ id: primary.id }));
    await app.viewer.waitForAsset(primary);

    const brokenAssets = app.viewer.stackBrokenAssets;
    await expect(brokenAssets).toHaveCount(broken.length);
    for (const brokenAsset of await brokenAssets.all()) {
      await expect(brokenAsset.getByText('error_loading_image')).toBeVisible();
      await expect(brokenAsset.getByRole('img', { includeHidden: true })).not.toBeVisible();
    }
    expect(logger.error).toHaveBeenCalledWith(/404/);
  });

  test('main viewer shows the icon and the message', async ({ page, data, logger, app }) => {
    const asset = factory.asset();
    data.addAssets(asset).markBroken(asset);
    await page.goto(Route.viewAsset({ id: asset.id }));
    await expect(app.viewer.root).toBeVisible();

    const brokenAsset = app.viewer.brokenAsset;
    await expect(brokenAsset.getByText('error_loading_image')).toBeVisible();
    await expect(brokenAsset.getByRole('img', { includeHidden: true })).toBeVisible();
    expect(logger.error).toHaveBeenCalledWith(/404/);
  });
});
