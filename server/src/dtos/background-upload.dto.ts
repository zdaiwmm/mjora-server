import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetMediaCreateDto } from 'src/dtos/asset-media.dto.js';

export class BackgroundUploadCreateDto extends createZodDto(
  AssetMediaCreateDto.schema.extend({
    filename: z.string().min(1).max(255),
    checksum: z.string().min(28).max(40),
    size: z
      .number()
      .int()
      .positive()
      .max(1024 ** 4),
  }),
) {}
