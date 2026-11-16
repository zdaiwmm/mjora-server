import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PhotoParametersSchema } from 'src/dtos/editing.dto.js';

const decimal = z
  .string()
  .refine((value) => /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n, {
    message: 'Expected a nonnegative Int64 decimal string',
    abort: true,
  });
const revision = z.string().min(1).max(4096);
const dimension = z.int().positive();

export const MediaTimeSchema = z.strictObject({
  value: decimal,
  timescale: z.int().positive().max(1_000_000_000),
});
export type MediaTime = z.infer<typeof MediaTimeSchema>;

// BigInt keeps comparisons exact even at the Int64 limit or with different time bases.
export function compareMediaTime(left: MediaTime, right: MediaTime): number {
  const difference = BigInt(left.value) * BigInt(right.timescale) - BigInt(right.value) * BigInt(left.timescale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

const ColorProfileSchema = z.enum(['sdrSRGB', 'sdr709', 'displayP3', 'hdrHLG', 'hdrPQ', 'log', 'unknown']);
const DisplayTransformSchema = z
  .strictObject({ a: z.number(), b: z.number(), c: z.number(), d: z.number(), tx: z.number(), ty: z.number() })
  .refine(
    (matrix) =>
      Number.isFinite(matrix.a * matrix.d - matrix.b * matrix.c) && matrix.a * matrix.d !== matrix.b * matrix.c,
    {
      message: 'Display transform must be invertible',
    },
  );
const ApertureSchema = z.strictObject({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const SourceComponentSchema = z.strictObject({
  role: z.enum(['originalPhoto', 'originalVideo', 'originalMotion', 'foreignCurrent']),
  remoteAssetID: z.uuid(),
  digest: z.strictObject({ algorithm: z.literal('sha256'), hex: z.string().regex(/^[0-9a-f]{64}$/) }),
  byteCount: decimal.refine((value) => value !== '0'),
  contentRevision: revision,
  displayWidth: dimension,
  displayHeight: dimension,
  displayTransform: DisplayTransformSchema,
  cleanAperture: ApertureSchema,
  colorProfile: ColorProfileSchema,
});
export type SourceComponent = z.infer<typeof SourceComponentSchema>;

export const SourceManifestSchema = z.strictObject({
  sourceRevision: revision,
  baselineKind: z.enum(['unadjusted', 'imoraKnown', 'foreignCurrent']),
  components: z.array(SourceComponentSchema).min(1).max(2),
  displayWidth: dimension,
  displayHeight: dimension,
  colorProfile: ColorProfileSchema,
  orientationRevision: revision,
  duration: MediaTimeSchema.optional(),
  frameIndexRevision: revision.optional(),
});
export type SourceManifest = z.infer<typeof SourceManifestSchema>;

export const GeometryV1Schema = z.strictObject({
  crop: z
    .strictObject({ x: z.int().nonnegative(), y: z.int().nonnegative(), width: z.int().min(2), height: z.int().min(2) })
    .nullable(),
  mirrorHorizontal: z.boolean(),
  mirrorVertical: z.boolean(),
  quarterTurnsClockwise: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  straighten: z.literal(0),
  horizontalPerspective: z.literal(0),
  verticalPerspective: z.literal(0),
});

export const PhotoColorV1Schema = PhotoParametersSchema.omit({
  straighten: true,
  horizontalPerspective: true,
  verticalPerspective: true,
}).strict();

export const MediaEditIntentV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.enum(['live', 'video']),
    source: SourceManifestSchema,
    geometry: GeometryV1Schema,
    color: PhotoColorV1Schema,
    live: z
      .strictObject({
        in: MediaTimeSchema,
        out: MediaTimeSchema,
        cover: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('originalPhoto') }),
          z.strictObject({ kind: z.literal('videoFrame'), pts: MediaTimeSchema }),
        ]),
        normalMuted: z.boolean(),
        effect: z.enum(['normal', 'loop', 'bounce']),
      })
      .optional(),
    video: z.strictObject({ in: MediaTimeSchema, out: MediaTimeSchema, muted: z.boolean() }).optional(),
    renderProfile: z.literal('sdr709-1080-v1'),
  })
  .superRefine((intent, context) => {
    const reject = (message: string, path: PropertyKey[]) => context.addIssue({ code: 'custom', message, path });
    const range = intent.kind === 'live' ? intent.live : intent.video;
    if (!range || (intent.kind === 'live' ? intent.video : intent.live)) {
      reject('Exactly one edit matching kind is required', [intent.kind]);
      return;
    }
    const duration = intent.source.duration;
    if (!duration || duration.value === '0' || !intent.source.frameIndexRevision) {
      reject('A prepared positive duration and frame index are required', ['source']);
      return;
    }
    if (compareMediaTime(range.in, range.out) >= 0 || compareMediaTime(range.out, duration) > 0) {
      reject('INVALID_TIME_RANGE', [intent.kind, 'out']);
    }
    const completeSource = range.in.value === '0' && compareMediaTime(range.out, duration) === 0;
    const minimum = intent.kind === 'live' ? 3n : 1n;
    const spanNumerator =
      BigInt(range.out.value) * BigInt(range.in.timescale) - BigInt(range.in.value) * BigInt(range.out.timescale);
    const spanDenominator = BigInt(range.out.timescale) * BigInt(range.in.timescale);
    if (
      (!completeSource || (intent.live && intent.live.effect !== 'normal')) &&
      spanNumerator * 10n < minimum * spanDenominator
    ) {
      reject('INVALID_TIME_RANGE', [intent.kind]);
    }
    const cover = intent.live?.cover;
    if (
      cover?.kind === 'videoFrame' &&
      (compareMediaTime(cover.pts, range.in) < 0 || compareMediaTime(cover.pts, range.out) >= 0)
    ) {
      reject('COVER_OUTSIDE_RANGE', ['live', 'cover']);
    }
    const crop = intent.geometry.crop;
    if (
      crop &&
      (crop.x > intent.source.displayWidth - crop.width || crop.y > intent.source.displayHeight - crop.height)
    ) {
      reject('Crop exceeds the source display rectangle', ['geometry', 'crop']);
    }
  });

export type MediaEditIntentV1 = z.infer<typeof MediaEditIntentV1Schema>;
export class MediaEditIntentDto extends createZodDto(MediaEditIntentV1Schema) {}
