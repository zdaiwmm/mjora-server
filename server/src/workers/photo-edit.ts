import { parentPort, workerData } from 'node:worker_threads';
import type { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import type { Bitmap } from 'src/types.js';

// Native Node TypeScript stripping runs this same isolated worker in source tests.
// Production builds use the emitted JavaScript module beside it.
const extension = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
const { applyPhotoEdits } = await import(new URL(`../utils/photo-edit${extension}`, import.meta.url).href);
const { bytes, info, edits } = workerData as {
  bytes: Uint8Array;
  info: Bitmap['info'];
  edits: AssetEditActionItem[];
};
const rendered: Bitmap = applyPhotoEdits(
  { data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), info },
  edits,
);
const output = new Uint8Array(rendered.data);
parentPort!.postMessage({ bytes: output, info: rendered.info }, [output.buffer]);
