import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MediaEditIntentV1Schema } from 'src/dtos/media-edit.dto.js';

/** Hash the received bytes, never a parsed/reserialized approximation of the operation. */
export function parseMediaEditBody(body: Buffer) {
  if (body.byteLength > 256 * 1024) {
    throw new HttpException({ code: 'PAYLOAD_TOO_LARGE' }, HttpStatus.PAYLOAD_TOO_LARGE);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new BadRequestException({ code: 'INVALID_JSON' });
  }
  const pending = [{ value, depth: 1 }];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.value === null || typeof node.value !== 'object') continue;
    if (node.depth > 16) throw new BadRequestException({ code: 'JSON_TOO_DEEP' });
    for (const child of Object.values(node.value)) pending.push({ value: child, depth: node.depth + 1 });
  }
  const parsed = MediaEditIntentV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpException(
      { code: 'INVALID_MEDIA_EDIT', issues: parsed.error.issues },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return { intent: parsed.data, requestHash: createHash('sha256').update(body).digest('hex') };
}
