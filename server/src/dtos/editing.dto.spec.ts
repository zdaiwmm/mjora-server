import { AssetEditsCreateDto } from 'src/dtos/editing.dto.js';

const photo = (parameters?: Record<string, unknown>) => ({ action: 'photo', parameters: parameters ?? { version: 1 } });

describe('photo edit wire validation', () => {
  it('fills omitted v1 members with complete neutral values', () => {
    expect(AssetEditsCreateDto.schema.parse({ edits: [photo()] })).toEqual({
      edits: [
        photo({
          version: 1,
          exposure: 0,
          contrast: 0,
          saturation: 0,
          invert: false,
          highlights: 0,
          shadows: 0,
          brightness: 0,
          blackPoint: 0,
          warmth: 0,
          tint: 0,
          straighten: 0,
          horizontalPerspective: 0,
          verticalPerspective: 0,
        }),
      ],
    });
  });

  it.each([
    'exposure',
    'contrast',
    'saturation',
    'highlights',
    'shadows',
    'brightness',
    'blackPoint',
    'warmth',
    'tint',
  ])('bounds %s without losing fractional intent', (key) => {
    for (const value of [-100, -0.125, 100]) {
      const parsed = AssetEditsCreateDto.schema.parse({ edits: [photo({ version: 1, [key]: value })] });
      expect(parsed.edits[0].parameters).toMatchObject({ [key]: value });
    }
    for (const value of [-100.01, 100.01, NaN, Infinity, '20']) {
      expect(AssetEditsCreateDto.schema.safeParse({ edits: [photo({ version: 1, [key]: value })] }).success).toBe(
        false,
      );
    }
  });

  it.each([
    ['straighten', 45],
    ['horizontalPerspective', 1],
    ['verticalPerspective', 1],
  ])('bounds %s', (key, bound) => {
    for (const value of [-Number(bound), Number(bound)]) {
      expect(AssetEditsCreateDto.schema.safeParse({ edits: [photo({ version: 1, [key]: value })] }).success).toBe(true);
    }
    for (const value of [-Number(bound) - 0.001, Number(bound) + 0.001, NaN, Infinity]) {
      expect(AssetEditsCreateDto.schema.safeParse({ edits: [photo({ version: 1, [key]: value })] }).success).toBe(
        false,
      );
    }
  });

  it('rejects unsupported versions, invalid booleans, duplicates, and photo before legacy edits', () => {
    const invalid = [
      [photo({ version: 2 })],
      [photo({})],
      [photo({ version: 1, invert: 1 })],
      [photo(), photo()],
      [photo(), { action: 'rotate', parameters: { angle: 90 } }],
    ];
    for (const edits of invalid) {
      expect(AssetEditsCreateDto.schema.safeParse({ edits }).success).toBe(false);
    }
  });

  it('accepts the complete mixed legacy sequence', () => {
    expect(
      AssetEditsCreateDto.schema.safeParse({
        edits: [
          { action: 'crop', parameters: { x: 0, y: 0, width: 1, height: 3 } },
          { action: 'mirror', parameters: { axis: 'horizontal' } },
          { action: 'mirror', parameters: { axis: 'vertical' } },
          { action: 'rotate', parameters: { angle: 90 } },
          photo(),
        ],
      }).success,
    ).toBe(true);
  });
});
