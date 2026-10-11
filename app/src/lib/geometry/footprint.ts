// Building footprints: the collider boxes of a placed building as grid-space OBBs.
import type { Building } from '../data';
import type { PlacedBuilding } from './model';
import type { OBB2 } from './obb';
import { LEVEL, prefabToGrid, rotateYaw, TILE } from './transform';

/**
 * The boxes a placed building occupies. These are its colliders with usage `build` (all colliders when none is
 * tagged `build`). A collider turned about the up axis becomes an exact turned box; a tilted collider is bounded
 * by its shadow on the ground (the frame follows the horizontal part of its x axis), so it never under-reports.
 */
export function buildingOBBs(b: PlacedBuilding, bd: Building): OBB2[] {
  const build = bd.geometry.colliders.filter((c) => c.usage === 'build');
  const colliders = build.length > 0 ? build : bd.geometry.colliders;
  return colliders.map((c) => {
    const centre = prefabToGrid(b, c.center);
    const [qx, qy, qz, qw] = c.rotation;
    // The collider's local x, y and z axes in prefab space (columns of its rotation matrix).
    const axes: [number, number, number][] = [
      [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)],
      [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)],
      [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)],
    ];
    const half = c.halfExtents;
    // Each axis' horizontal part in grid (east, north); its vertical part is axis[1].
    const flat = axes.map((a) => rotateYaw(a[0], a[2], b.yaw));

    // Frame: the horizontal direction of local x (of local z if x is vertical).
    let [ux, uy] = flat[0];
    if (Math.hypot(ux, uy) < 1e-9) [ux, uy] = flat[2];
    const len = Math.hypot(ux, uy);
    if (len < 1e-9) [ux, uy] = [1, 0];
    else [ux, uy] = [ux / len, uy / len];
    const [vx, vy] = [-uy, ux];

    // Support of the box along each frame direction: sum of half extent times the axis' share of it.
    let hu = 0;
    let hv = 0;
    let hz = 0;
    for (let i = 0; i < 3; i++) {
      hu += half[i] * Math.abs(flat[i][0] * ux + flat[i][1] * uy);
      hv += half[i] * Math.abs(flat[i][0] * vx + flat[i][1] * vy);
      hz += half[i] * Math.abs(axes[i][1]);
    }
    return {
      cx: centre.x,
      cy: centre.y,
      hx: hu / TILE,
      hy: hv / TILE,
      angle: Math.atan2(uy, ux),
      zMin: centre.z - hz / LEVEL,
      zMax: centre.z + hz / LEVEL,
    };
  });
}
