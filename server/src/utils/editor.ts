import { AssetFace } from 'src/database.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { AssetOcrResponseDto } from 'src/dtos/ocr.dto.js';
import type { ImageDimensions } from 'src/types.js';
import { Point, getOutputDimensions, transformPoints } from 'src/utils/transform.js';

type BoundingBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export const boundingBoxOverlap = (boxA: BoundingBox, boxB: BoundingBox) => {
  const overlapX1 = Math.max(boxA.x1, boxB.x1);
  const overlapY1 = Math.max(boxA.y1, boxB.y1);
  const overlapX2 = Math.min(boxA.x2, boxB.x2);
  const overlapY2 = Math.min(boxA.y2, boxB.y2);

  const overlapArea = Math.max(0, overlapX2 - overlapX1) * Math.max(0, overlapY2 - overlapY1);
  const faceArea = (boxA.x2 - boxA.x1) * (boxA.y2 - boxA.y1);
  return overlapArea / faceArea;
};

const visibleFootprint = (edits: AssetEditActionItem[], dimensions: ImageDimensions) => {
  if (edits.every((edit) => edit.action !== 'photo')) {
    return;
  }
  const output = getOutputDimensions(edits, dimensions);
  return transformPoints(
    [
      { x: 0, y: 0 },
      { x: output.width, y: 0 },
      { x: output.width, y: output.height },
      { x: 0, y: output.height },
    ],
    edits,
    output,
    { inverse: true },
  ).points;
};

const polygonOverlap = (box: BoundingBox, footprint: Point[]) => {
  let polygon = footprint;
  for (const [axis, limit, minimum] of [
    ['x', box.x1, true],
    ['x', box.x2, false],
    ['y', box.y1, true],
    ['y', box.y2, false],
  ] as const) {
    const result: Point[] = [];
    for (const [index, point] of polygon.entries()) {
      const previous = polygon[(index + polygon.length - 1) % polygon.length];
      const inside = minimum ? point[axis] >= limit : point[axis] <= limit;
      const previousInside = minimum ? previous[axis] >= limit : previous[axis] <= limit;
      if (inside !== previousInside) {
        const fraction = (limit - previous[axis]) / (point[axis] - previous[axis]);
        result.push({
          x: previous.x + fraction * (point.x - previous.x),
          y: previous.y + fraction * (point.y - previous.y),
        });
      }
      if (inside) {
        result.push(point);
      }
    }
    polygon = result;
  }
  let signedArea = 0;
  for (const [index, point] of polygon.entries()) {
    const next = polygon[(index + 1) % polygon.length];
    signedArea += point.x * next.y - point.y * next.x;
  }
  const area = Math.abs(signedArea) / 2;
  return area / ((box.x2 - box.x1) * (box.y2 - box.y1));
};

const scale = (box: BoundingBox, target: ImageDimensions, source?: ImageDimensions) => {
  const { width: sourceWidth = 1, height: sourceHeight = 1 } = source ?? {};

  return {
    x1: (box.x1 / sourceWidth) * target.width,
    y1: (box.y1 / sourceHeight) * target.height,
    x2: (box.x2 / sourceWidth) * target.width,
    y2: (box.y2 / sourceHeight) * target.height,
  };
};

export const checkFaceVisibility = (
  faces: AssetFace[],
  originalAssetDimensions: ImageDimensions,
  crop?: BoundingBox,
  edits: AssetEditActionItem[] = [],
): { visible: AssetFace[]; hidden: AssetFace[] } => {
  const footprint = visibleFootprint(edits, originalAssetDimensions);
  if (!crop && !footprint) {
    return {
      visible: faces.filter((face) => !face.isVisible),
      hidden: [],
    };
  }

  const status = faces.map((face) => {
    const scaledFace = scale(
      {
        x1: face.boundingBoxX1,
        y1: face.boundingBoxY1,
        x2: face.boundingBoxX2,
        y2: face.boundingBoxY2,
      },
      originalAssetDimensions,
      { width: face.imageWidth, height: face.imageHeight },
    );

    const overlapPercentage = footprint ? polygonOverlap(scaledFace, footprint) : boundingBoxOverlap(scaledFace, crop!);

    return {
      face,
      isVisible: overlapPercentage >= 0.5,
    };
  });

  return {
    visible: status.filter((s) => s.isVisible).map((s) => s.face),
    hidden: status.filter((s) => !s.isVisible).map((s) => s.face),
  };
};

export const checkOcrVisibility = (
  ocrs: (AssetOcrResponseDto & { isVisible: boolean })[],
  originalAssetDimensions: ImageDimensions,
  crop?: BoundingBox,
  edits: AssetEditActionItem[] = [],
): { visible: AssetOcrResponseDto[]; hidden: AssetOcrResponseDto[] } => {
  const footprint = visibleFootprint(edits, originalAssetDimensions);
  if (!crop && !footprint) {
    return {
      visible: ocrs.filter((ocr) => !ocr.isVisible),
      hidden: [],
    };
  }

  const status = ocrs.map((ocr) => {
    const ocrBox = scale(
      {
        x1: Math.min(ocr.x1, ocr.x2, ocr.x3, ocr.x4),
        y1: Math.min(ocr.y1, ocr.y2, ocr.y3, ocr.y4),
        x2: Math.max(ocr.x1, ocr.x2, ocr.x3, ocr.x4),
        y2: Math.max(ocr.y1, ocr.y2, ocr.y3, ocr.y4),
      },
      originalAssetDimensions,
    );

    const overlapPercentage = footprint ? polygonOverlap(ocrBox, footprint) : boundingBoxOverlap(ocrBox, crop!);

    return {
      ocr,
      isVisible: overlapPercentage >= 0.5,
    };
  });

  return {
    visible: status.filter((s) => s.isVisible).map((s) => s.ocr),
    hidden: status.filter((s) => !s.isVisible).map((s) => s.ocr),
  };
};
