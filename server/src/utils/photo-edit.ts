import { AssetEditActionItem, PhotoParameters, PhotoParametersSchema } from 'src/dtos/editing.dto.js';
import type { Bitmap } from 'src/types.js';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const identityPoint = (x: number, y: number) => ({ x, y });
const luma = (r: number, g: number, b: number) => 0.213 * r + 0.715 * g + 0.072 * b;

/** Normalized, top-left oriented inverse warp shared with the native editor. */
export const createPhotoWarp = (parameters: PhotoParameters) => {
  const angle = (parameters.straighten * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const h = parameters.horizontalPerspective * 0.25;
  const v = parameters.verticalPerspective * 0.25;
  const inverse = (x: number, y: number) => {
    const denominator = 1 + h * x + v * y;
    return { x: (c * x + s * y) / denominator, y: (-s * x + c * y) / denominator };
  };
  let maximum = 1;
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      const point = inverse(x, y);
      maximum = Math.max(maximum, Math.abs(point.x), Math.abs(point.y));
    }
  }
  return {
    inverse: (x: number, y: number) => {
      const point = inverse(x, y);
      return { x: point.x / maximum, y: point.y / maximum };
    },
    forward: (x: number, y: number) => {
      const rx = maximum * (c * x - s * y);
      const ry = maximum * (s * x + c * y);
      // Points on/behind the projective pole are outside the visible footprint.
      // Keep their offscreen metadata representation finite during derivative regeneration.
      const denominator = Math.max(Number.EPSILON, 1 - h * rx - v * ry);
      return { x: rx / denominator, y: ry / denominator };
    },
  };
};

/** Integer crop/mirror/quarter turns keep odd and single-pixel axes lossless. */
const legacyGeometry = (image: Bitmap, edits: AssetEditActionItem[]): Bitmap => {
  for (const edit of edits) {
    const { width, height, channels } = image.info;
    let outWidth = width;
    let outHeight = height;
    let source = identityPoint;
    switch (edit.action) {
      case 'crop': {
        const { x, y, width, height } = edit.parameters;
        outWidth = width;
        outHeight = height;
        source = (sx, sy) => ({ x: sx + x, y: sy + y });
        break;
      }
      case 'mirror': {
        source =
          edit.parameters.axis === 'horizontal'
            ? (x, y) => ({ x, y: height - 1 - y })
            : (x, y) => ({ x: width - 1 - x, y });
        break;
      }
      case 'rotate': {
        const { angle } = edit.parameters;
        if (angle === 90 || angle === 270) {
          [outWidth, outHeight] = [height, width];
        }
        source =
          angle === 90
            ? (x, y) => ({ x: y, y: height - 1 - x })
            : angle === 180
              ? (x, y) => ({ x: width - 1 - x, y: height - 1 - y })
              : angle === 270
                ? (x, y) => ({ x: width - 1 - y, y: x })
                : source;
        break;
      }
      default: {
        continue;
      }
    }
    const data = Buffer.alloc(outWidth * outHeight * channels);
    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        const point = source(x, y);
        const offset = (point.y * width + point.x) * channels;
        image.data.copy(data, (y * outWidth + x) * channels, offset, offset + channels);
      }
    }
    image = { data, info: { width: outWidth, height: outHeight, channels } };
  }
  return image;
};

/** Input/output are gamma-encoded sRGB bytes; warp interpolation precedes color math. */
export const applyPhotoEdits = (input: Bitmap, edits: AssetEditActionItem[]): Bitmap => {
  const photo = edits.find((edit) => edit.action === 'photo');
  if (!photo) {
    return input;
  }
  const p = PhotoParametersSchema.parse(photo.parameters);
  const image = legacyGeometry(input, edits);
  const { width, height, channels } = image.info;
  const warp = createPhotoWarp(p);
  const data = Buffer.alloc(image.data.length);
  const sample = (x: number, y: number, channel: number) => image.data[(y * width + x) * channels + channel] / 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const point = warp.inverse(
        width === 1 ? 0 : (2 * x) / (width - 1) - 1,
        height === 1 ? 0 : (2 * y) / (height - 1) - 1,
      );
      const sx = Math.max(0, Math.min(width - 1, ((point.x + 1) * (width - 1)) / 2));
      const sy = Math.max(0, Math.min(height - 1, ((point.y + 1) * (height - 1)) / 2));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const dx = sx - x0;
      const dy = sy - y0;
      const values = Array.from(
        { length: channels },
        (_, channel) =>
          (sample(x0, y0, channel) * (1 - dx) + sample(x1, y0, channel) * dx) * (1 - dy) +
          (sample(x0, y1, channel) * (1 - dx) + sample(x1, y1, channel) * dx) * dy,
      );
      let [r, g, b] = values;
      const gray = luma(r, g, b);
      const saturation = 1 + p.saturation / 100;
      [r, g, b] = [r, g, b].map((value) => clamp(gray + saturation * (value - gray)));
      if (p.invert) {
        [r, g, b] = [1 - r, 1 - g, 1 - b];
      }
      [r, g, b] = [r, g, b].map((value) => clamp(value * (1 + p.exposure / 100)));
      const highlight = ((0.5 * p.highlights) / 100) * luma(r, g, b) ** 2;
      [r, g, b] = [r, g, b].map((value) => clamp(value + highlight));
      const shadow = ((0.5 * p.shadows) / 100) * (1 - luma(r, g, b)) ** 2;
      [r, g, b] = [r, g, b].map((value) => clamp(value + shadow));
      [r, g, b] = [r, g, b].map((value) => clamp(value + (0.5 * p.brightness) / 100));
      const black = (0.5 * p.blackPoint) / 100;
      [r, g, b] = [r, g, b].map((value) => clamp((value - black) / (1 - black)));
      r = clamp(r + (0.15 * p.warmth) / 100);
      b = clamp(b - (0.15 * p.warmth) / 100);
      [r, g, b] = [
        clamp(r + (0.075 * p.tint) / 100),
        clamp(g - (0.15 * p.tint) / 100),
        clamp(b + (0.075 * p.tint) / 100),
      ];
      [r, g, b] = [r, g, b].map((value) => clamp((value - 0.5) * (1 + p.contrast / 100) + 0.5));
      const offset = (y * width + x) * channels;
      for (const [channel, value] of [r, g, b, ...values.slice(3)].entries()) {
        data[offset + channel] = Math.round(value * 255);
      }
    }
  }
  return { data, info: image.info };
};
