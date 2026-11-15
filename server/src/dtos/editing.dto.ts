import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export enum AssetEditAction {
  Crop = 'crop',
  Rotate = 'rotate',
  Mirror = 'mirror',
  Photo = 'photo',
}

export const AssetEditActionSchema = z
  .enum(AssetEditAction)
  .describe('Type of edit action to perform')
  .meta({ id: 'AssetEditAction' });

export enum MirrorAxis {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
}

const MirrorAxisSchema = z.enum(['horizontal', 'vertical']).describe('Axis to mirror along').meta({ id: 'MirrorAxis' });

const CropParametersSchema = z
  .object({
    x: z.int().min(0).describe('Top-Left X coordinate of crop'),
    y: z.int().min(0).describe('Top-Left Y coordinate of crop'),
    width: z.int().min(1).describe('Width of the crop'),
    height: z.int().min(1).describe('Height of the crop'),
  })
  .meta({ id: 'CropParameters' });

const RotateParametersSchema = z
  .object({
    angle: z
      .int()
      .min(0)
      .max(270)
      .refine((v) => [0, 90, 180, 270].includes(v), {
        error: 'Angle must be one of the following values: 0, 90, 180, 270',
      })
      .describe('Rotation angle in degrees'),
  })
  .meta({ id: 'RotateParameters' });

const MirrorParametersSchema = z
  .object({
    axis: MirrorAxisSchema,
  })
  .meta({ id: 'MirrorParameters' });

const amount = () => z.number().min(-100).max(100).default(0).meta({ format: 'double' });

export const PhotoParametersSchema = z
  .object({
    version: z.literal(1).meta({ type: 'integer' }),
    exposure: amount(),
    contrast: amount(),
    saturation: amount(),
    invert: z.boolean().default(false),
    highlights: amount(),
    shadows: amount(),
    brightness: amount(),
    blackPoint: amount(),
    warmth: amount(),
    tint: amount(),
    straighten: z.number().min(-45).max(45).default(0).meta({ format: 'double' }),
    horizontalPerspective: z.number().min(-1).max(1).default(0).meta({ format: 'double' }),
    verticalPerspective: z.number().min(-1).max(1).default(0).meta({ format: 'double' }),
  })
  .meta({ id: 'PhotoParameters' });

export type PhotoParameters = z.infer<typeof PhotoParametersSchema>;

// TODO: ideally we would use the discriminated union directly in the future not only for type support but also for validation and openapi generation
const __AssetEditActionItemSchema = z.discriminatedUnion('action', [
  z.object({ action: AssetEditActionSchema.extract(['Crop']), parameters: CropParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Rotate']), parameters: RotateParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Mirror']), parameters: MirrorParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Photo']), parameters: PhotoParametersSchema }),
]);

const AssetEditParametersSchema = z
  .union([CropParametersSchema, RotateParametersSchema, MirrorParametersSchema, PhotoParametersSchema], {
    error: getExpectedKeysByActionMessage,
  })
  .describe('List of edit actions to apply (crop, rotate, mirror, or photo)');

const actionParameterMap = {
  [AssetEditAction.Crop]: CropParametersSchema,
  [AssetEditAction.Rotate]: RotateParametersSchema,
  [AssetEditAction.Mirror]: MirrorParametersSchema,
  [AssetEditAction.Photo]: PhotoParametersSchema,
} as const;

function getExpectedKeysByActionMessage(): string {
  const expectedByAction = Object.entries(actionParameterMap)
    .map(([action, schema]) => `${action}: [${Object.keys(schema.shape).join(', ')}]`)
    .join('; ');

  return `Invalid parameters for action, expected keys by action: ${expectedByAction}`;
}

function isParametersValidForAction(edit: z.infer<typeof AssetEditActionItemSchema>): boolean {
  return actionParameterMap[edit.action].safeParse(edit.parameters).success;
}

const AssetEditActionItemSchema = z
  .object({
    action: AssetEditActionSchema,
    parameters: AssetEditParametersSchema,
  })
  .superRefine((edit, ctx) => {
    if (!isParametersValidForAction(edit)) {
      ctx.addIssue({
        code: 'custom',
        path: ['parameters'],
        message: `Invalid parameters for action '${edit.action}', expecting keys: ${Object.keys(actionParameterMap[edit.action].shape).join(', ')}`,
      });
    }
  })
  .meta({ id: 'AssetEditActionItemDto' });

export type AssetEditActionItem = z.infer<typeof __AssetEditActionItemSchema>;
export type AssetEditParameters = AssetEditActionItem['parameters'];

function uniqueEditActions(edits: z.infer<typeof AssetEditActionItemSchema>[]): boolean {
  const keys = new Set<string>();
  for (const edit of edits) {
    const key = edit.action === 'mirror' ? `mirror-${JSON.stringify(edit.parameters)}` : edit.action;
    if (keys.has(key)) {
      return false;
    }
    keys.add(key);
  }
  return true;
}

const AssetEditsCreateSchema = z
  .object({
    edits: z
      .array(AssetEditActionItemSchema)
      .min(1)
      .describe('List of edit actions to apply (crop, rotate, mirror, or photo)')
      .refine(uniqueEditActions, { error: 'Duplicate edit actions are not allowed' })
      .refine(
        (edits) => edits.every((edit, index) => edit.action !== AssetEditAction.Photo || index === edits.length - 1),
        { error: 'Photo action must be the last edit action' },
      ),
  })
  .meta({ id: 'AssetEditsCreateDto' });

const AssetEditActionItemResponseSchema = AssetEditActionItemSchema.extend({
  id: z.uuidv4().describe('Asset edit ID'),
}).meta({ id: 'AssetEditActionItemResponseDto' });

const AssetEditsResponseSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID these edits belong to'),
    edits: z.array(AssetEditActionItemResponseSchema).describe('List of edit actions applied to the asset'),
  })
  .meta({ id: 'AssetEditsResponseDto' });

export class AssetEditActionItemResponseDto extends createZodDto(AssetEditActionItemResponseSchema) {}
export class AssetEditsCreateDto extends createZodDto(AssetEditsCreateSchema) {}
export class AssetEditsResponseDto extends createZodDto(AssetEditsResponseSchema) {}
export type CropParameters = z.infer<typeof CropParametersSchema>;
