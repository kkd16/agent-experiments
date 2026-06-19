// Render one tile's voxel model to a small isometric sprite — the 3D gallery's thumbnails. Just
// the rasteriser pointed at a one-cell field with a fixed three-quarter camera.

import { Camera } from './camera';
import { VoxField } from './field';
import { renderField } from './raster';
import type { VoxModel } from './voxel';

export function renderThumb(model: VoxModel, px = 72): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const field = new VoxField(1, 1, 1, model.res);
  field.place(model, 0, 0, 0);
  const cam = new Camera(0.72, 0.62, 1, px / 2, px / 2);
  cam.scale = (px / (model.res * 1.7)) * 1;
  cam.cy = px / 2 + model.res * 0.16 * cam.scale;
  cam.refresh();
  if (field.filled > 0) renderField(ctx, field, cam, px, px, true);
  return c;
}
