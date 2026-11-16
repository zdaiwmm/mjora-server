import {
  MediaEditIntentV1,
  MediaEditIntentV1Schema,
  MediaTimeSchema,
  compareMediaTime,
} from 'src/dtos/media-edit.dto.js';
import fixture from 'test/fixtures/media-edit-video.json' with { type: 'json' };

const time = (value: string, timescale = 1000) => ({ value, timescale });
const intent = (): MediaEditIntentV1 => MediaEditIntentV1Schema.parse(structuredClone(fixture));

describe('media-edit v1 contract', () => {
  it('compares equivalent rational times and adjacent Int64 values exactly', () => {
    expect(compareMediaTime(time('1', 3), time('2', 6))).toBe(0);
    expect(
      compareMediaTime(time('9223372036854775806', 1_000_000_000), time('9223372036854775807', 1_000_000_000)),
    ).toBe(-1);
    expect(compareMediaTime(time('9223372036854775807', 1), time('9223372036854775807', 2))).toBe(1);
  });

  it.each([time('-1'), time('1.0'), time('9223372036854775808'), time('1', 0), time('1', 1_000_000_001)])(
    'rejects invalid time %j',
    (value) => expect(MediaTimeSchema.safeParse(value).success).toBe(false),
  );

  it('accepts a short complete source without pretending that it meets the trim minimum', () => {
    const value = intent();
    value.source.duration = time('80');
    value.video!.out = time('80');
    expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(true);
    value.video!.in = time('1');
    expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(false);
  });

  it('requires cover inside the actual half-open selected range and live effects minimum', () => {
    const value = intent();
    value.kind = 'live';
    delete value.video;
    value.live = {
      in: time('100'),
      out: time('1000'),
      cover: { kind: 'videoFrame', pts: time('1000') },
      normalMuted: true,
      effect: 'normal',
    };
    expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(false);
    value.live.cover = { kind: 'videoFrame', pts: time('999') };
    expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(true);
    value.source.duration = time('80');
    value.live.in = time('0');
    value.live.out = time('80');
    value.live.cover = { kind: 'originalPhoto' };
    expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(true);
    value.live.effect = 'bounce';
    expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(false);
  });

  it('rejects swapped edit kind, non-finite color, singular transform, SHA-1 and paths', () => {
    const wrongKind = intent();
    wrongKind.kind = 'live';
    const nonFinite = intent();
    nonFinite.color.exposure = NaN;
    const singular = intent();
    singular.source.components[0].displayTransform.d = 0;
    const sha1 = intent();
    sha1.source.components[0].digest.hex = 'a'.repeat(40);
    const cases = [
      wrongKind,
      nonFinite,
      singular,
      sha1,
      { ...intent(), localIdentifier: 'must-never-leave-device', originalPath: '/private/source.mov' },
    ];
    for (const value of cases) expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(false);
  });

  it('keeps crop in the reference space and rejects unsupported warp or profile', () => {
    const value = intent();
    value.geometry.crop = { x: 1919, y: 0, width: 2, height: 1080 };
    expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(false);
    value.geometry.crop = { x: 1, y: 1, width: 1919, height: 1079 };
    expect(MediaEditIntentV1Schema.safeParse(value).success).toBe(true);
    expect(
      MediaEditIntentV1Schema.safeParse({ ...value, geometry: { ...value.geometry, straighten: 1 } }).success,
    ).toBe(false);
    expect(MediaEditIntentV1Schema.safeParse({ ...value, renderProfile: 'hdr-passthrough' }).success).toBe(false);
  });
});
