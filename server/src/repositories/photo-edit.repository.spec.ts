import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AssetEditActionItem, AssetEditsCreateDto } from 'src/dtos/editing.dto.js';
import { ImageFormat } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';

const photo = (parameters: Record<string, unknown> = {}): AssetEditActionItem[] =>
  AssetEditsCreateDto.schema.parse({ edits: [{ action: 'photo', parameters: { version: 1, ...parameters } }] })
    .edits as AssetEditActionItem[];

describe('photo edits actual pixel pipeline', () => {
  let directory: string;
  const sut = new MediaRepository(LoggingRepository.create());
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-edit-'));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const render = async (
    pixels: number[],
    width: number,
    height: number,
    edits: AssetEditActionItem[],
    channels: 3 | 4 = 3,
  ) => {
    const output = path.join(directory, 'edited.png');
    const source = path.join(directory, 'original.png');
    await sharp(Buffer.from(pixels), { raw: { width, height, channels } }).png().toFile(source);
    const original = await fs.readFile(source);
    const decoded = await sut.decodeImage(source, { colorspace: 'srgb', processInvalidImages: false });
    await sut.generateThumbnail(
      decoded,
      {
        colorspace: 'srgb',
        processInvalidImages: false,
        format: 'png' as ImageFormat,
        quality: 100,
        decodingTier: 0,
        edits,
      },
      output,
    );
    expect(await fs.readFile(source)).toEqual(original);
    return sharp(output).raw().toBuffer({ resolveWithObject: true });
  };

  it('interpolates premultiplied transparent edges and returns straight RGBA', async () => {
    const row = [0, 255, 0, 255, 255, 0, 0, 0, 0, 0, 255, 255];
    const { data } = await render([...row, ...row, ...row], 3, 3, photo({ horizontalPerspective: 1 }), 4);
    expect([...data.subarray(20, 24)]).toEqual([0, 0, 255, 153]);
    expect(data[19]).toBe(0);
    const prepared = await sut.preparePhotoEdits(
      { data: Buffer.from([...row, ...row, ...row]), info: { width: 3, height: 3, channels: 4 } },
      photo({ horizontalPerspective: 1, invert: true }),
    );
    expect([...prepared.data.subarray(16, 20)]).toEqual([0, 0, 0, 0]);
  });

  it('allows a heartbeat timer to run while a photo render is pending', async () => {
    const image = { data: Buffer.alloc(500 * 500 * 3, 64), info: { width: 500, height: 500, channels: 3 as const } };
    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats++;
    }, 5);
    try {
      const result = await sut['transform'](image, { edits: photo({ exposure: 20 }) });
      expect(result.data[0]).toBe(77);
      expect(heartbeats).toBeGreaterThan(0);
      expect(image.data[0]).toBe(64);
      expect(image.data.length).toBe(750_000);
    } finally {
      clearInterval(timer);
    }
  });

  it.each([
    [1, 1],
    [1, 3],
    [3, 1],
    [3, 5],
  ])('neutral v1 preserves pixels at %ix%i', async (width, height) => {
    const pixels = Array.from({ length: width * height * 3 }, (_, i) => (i * 37 + 11) % 256);
    const { data, info } = await render(pixels, width, height, photo());
    expect([info.width, info.height]).toEqual([width, height]);
    expect([...data]).toEqual(pixels);
  });

  it.each([
    [{ saturation: -100 }, [119, 119, 119]],
    [{ invert: true }, [191, 127, 63]],
    [{ exposure: 50 }, [96, 192, 255]],
    [{ highlights: 100 }, [92, 156, 220]],
    [{ shadows: 100 }, [100, 164, 228]],
    [{ brightness: 50 }, [128, 192, 255]],
    [{ blackPoint: 50 }, [0, 86, 171]],
    [{ warmth: 100 }, [102, 128, 154]],
    [{ tint: 100 }, [83, 90, 211]],
    [{ contrast: 50 }, [32, 128, 224]],
  ])('applies nonlinear sRGB stage fixture %j', async (parameters, expected) => {
    const { data } = await render([64, 128, 192], 1, 1, photo(parameters));
    for (const [index, value] of data.entries()) {
      expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(1);
    }
  });

  it('warps an odd-sized coordinate fixture by inverse perspective with bilinear sampling', async () => {
    const pixels = [
      0, 0, 0, 100, 0, 0, 200, 0, 0, 0, 100, 0, 100, 100, 0, 200, 100, 0, 0, 200, 0, 100, 200, 0, 200, 200, 0,
    ];
    const { data, info } = await render(pixels, 3, 3, photo({ horizontalPerspective: 1 }));
    expect([info.width, info.height]).toEqual([3, 3]);
    expect([...data]).toEqual([
      0, 0, 0, 100, 25, 0, 160, 40, 0, 0, 100, 0, 100, 100, 0, 160, 100, 0, 0, 200, 0, 100, 175, 0, 160, 160, 0,
    ]);
  });

  it.each([
    [
      { verticalPerspective: 1 },
      [0, 0, 0, 100, 0, 0, 200, 0, 0, 25, 100, 0, 100, 100, 0, 175, 100, 0, 40, 160, 0, 100, 160, 0, 160, 160, 0],
    ],
    [
      { straighten: 45 },
      [0, 100, 0, 50, 50, 0, 100, 0, 0, 50, 150, 0, 100, 100, 0, 150, 50, 0, 100, 200, 0, 150, 150, 0, 200, 100, 0],
    ],
  ])('samples independently calculated vertical/straighten fixture %j', async (parameters, expected) => {
    const pixels = [
      0, 0, 0, 100, 0, 0, 200, 0, 0, 0, 100, 0, 100, 100, 0, 200, 100, 0, 0, 200, 0, 100, 200, 0, 200, 200, 0,
    ];
    const { data } = await render(pixels, 3, 3, photo(parameters));
    expect([...data]).toEqual(expected);
  });

  it('bilinearly warps before nonlinear clipped exposure', async () => {
    const pixels = [
      0, 0, 0, 100, 0, 0, 200, 0, 0, 0, 100, 0, 100, 100, 0, 200, 100, 0, 0, 200, 0, 100, 200, 0, 200, 200, 0,
    ];
    const { data } = await render(pixels, 3, 3, photo({ horizontalPerspective: 1, exposure: 100 }));
    expect([...data]).toEqual([
      0, 0, 0, 200, 50, 0, 255, 80, 0, 0, 200, 0, 200, 200, 0, 255, 200, 0, 0, 255, 0, 200, 255, 0, 255, 255, 0,
    ]);
  });

  it('applies crop, mirror and quarter rotation before photo color and warp', async () => {
    const edits = AssetEditsCreateDto.schema.parse({
      edits: [
        { action: 'crop', parameters: { x: 1, y: 0, width: 1, height: 3 } },
        { action: 'mirror', parameters: { axis: 'horizontal' } },
        { action: 'rotate', parameters: { angle: 90 } },
        { action: 'photo', parameters: { version: 1, invert: true } },
      ],
    }).edits as AssetEditActionItem[];
    const { data, info } = await render([0, 0, 0, 10, 20, 30, 0, 0, 0, 40, 50, 60, 0, 0, 0, 70, 80, 90], 2, 3, edits);
    expect([info.width, info.height]).toEqual([3, 1]);
    expect([...data]).toEqual([245, 235, 225, 215, 205, 195, 185, 175, 165]);
  });
});
