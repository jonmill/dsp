import { describe, expect, it } from 'vitest';
import { LEVEL } from '../../geometry';
import type { PlacedBuilding } from '../../geometry';
import { checkGeometry } from '../../validate';
import { patchBuilding } from '../../validate/testkit';
import { validateLayout } from '../../validate';
import { data, effects, MATRIX_LAB, matrixNetlist, matrixPlan, pipelineLayout, processorNetlist } from '../testkit';
import { labStackMotif } from './lab-stack';
import { applyMotifs } from './apply';

const at = (labLevel: number) => ({ ...effects, labLevel });
const labIds = (net: Awaited<ReturnType<typeof matrixNetlist>>): number[] =>
  net.machines.filter((m) => m.buildingItemId === MATRIX_LAB).map((m) => m.id);

describe('labStackMotif.propose', () => {
  it('stacks the 6 labs of a matrix stage at labLevel 3 as 2 stacks of 3', async () => {
    const net = await matrixNetlist(2, at(3));
    const labs = labIds(net);
    expect(labs).toHaveLength(6);
    const found = labStackMotif.propose(net, data, at(3));
    expect(found.map((i) => i.machineIds)).toEqual([labs.slice(0, 3), labs.slice(3)]);
    for (const instance of found) {
      expect(instance.kind).toBe('labStack');
      expect(instance.anchor).toEqual({ x: 0, y: 0, yaw: 0 });
      expect(instance.internalSorters).toEqual([]);
      const lap = Math.round(data.building(MATRIX_LAB)!.geometry.lapJoint[1] / LEVEL);
      expect(instance.relative).toEqual(
        instance.machineIds.map((machineId, i) => ({
          machineId,
          dx: 0,
          dy: 0,
          dz: i * lap,
          yaw: 0,
          ...(i > 0 ? { onTop: instance.machineIds[i - 1] } : {}),
        })),
      );
    }
  });

  it('names the nets whose taps the stack carries on its bottom lab: coils, boards and the matrices', async () => {
    const net = await matrixNetlist(2, at(3));
    const [first] = labStackMotif.propose(net, data, at(3));
    const uppers = first.machineIds.slice(1);
    const itemOf = (netId: number) => net.nets.find((n) => n.id === netId)!.itemId;
    expect(first.satisfiesNets.map((s) => itemOf(s.netId)).sort()).toEqual([1202, 1301, 6001]);
    for (const s of first.satisfiesNets) expect(s.machineIds).toEqual(uppers);
  });

  it('makes the stacks as even as it can: 7 labs at labLevel 3 are 3 + 2 + 2 high', async () => {
    const net = await matrixNetlist(7 / 3, at(3));
    expect(labIds(net)).toHaveLength(7);
    expect(labStackMotif.propose(net, data, at(3)).map((i) => i.machineIds.length)).toEqual([3, 2, 2]);
  });

  it('stacks as high as labLevel allows: 6 labs at labLevel 15 are one stack of 6; at labLevel 2, three of 2', async () => {
    const net = await matrixNetlist(2);
    expect(labStackMotif.propose(net, data, at(15)).map((i) => i.machineIds.length)).toEqual([6]);
    expect(labStackMotif.propose(net, data, at(2)).map((i) => i.machineIds.length)).toEqual([2, 2, 2]);
  });

  it('proposes nothing when the labs cannot stack (labLevel 1), or for machines that are not labs', async () => {
    expect(labStackMotif.propose(await matrixNetlist(2, at(1)), data, at(1))).toEqual([]);
    expect(labStackMotif.propose(await processorNetlist(), data, effects)).toEqual([]);
  });

  it('leaves out machines already taken, and the labs of a stack that would need more sorters than fit beside the bottom lab', async () => {
    const net = await matrixNetlist(2, at(3));
    const labs = labIds(net);
    const found = labStackMotif.propose(net, data, at(3), new Set([labs[0]]));
    expect(found.flatMap((i) => i.machineIds)).not.toContain(labs[0]);
    // five left: a stack of 3 and one of 2
    expect(found.map((i) => i.machineIds.length)).toEqual([3, 2]);

    // Mk.I sorters carry 1.5 items/s from a belt: 15 labs would ask for 5 coils/s, which is 4 sorters (> 3 fit)
    const slow = await matrixNetlist(5, { ...at(15), availableBuildings: new Set([...effects.availableBuildings].filter((id) => ![2012, 2013, 2014].includes(id))) });
    const heights = labStackMotif.propose(slow, data, at(15)).map((i) => i.machineIds.length);
    expect(Math.max(...heights)).toBeLessThan(15);
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(2);
  });

  it('proposes stacks the validator accepts: stackParentId chains of the right height, no overlap, nothing beyond labLevel', async () => {
    // the lab 10 m tall, so that without the exemption the stack would overlap
    const tall = patchBuilding(data, MATRIX_LAB, (b) => ({
      ...b,
      geometry: { ...b.geometry, colliders: b.geometry.colliders.map((c) => ({ ...c, center: [0, 5, 0], halfExtents: [c.halfExtents[0], 5, c.halfExtents[2]] })) },
    }));
    const net = await matrixNetlist(2, at(3));
    const [stack] = labStackMotif.propose(net, tall, at(3));
    const buildings: PlacedBuilding[] = stack.relative.map((r) => ({
      id: r.machineId,
      itemId: MATRIX_LAB,
      x: 40 + r.dx,
      y: 40 + r.dy,
      z: r.dz,
      yaw: r.yaw,
      ...(r.onTop === undefined ? {} : { stackParentId: r.onTop }),
    }));
    const layout = { buildings, belts: [], sorters: [], meta: { geometrySource: 'approximate' as const, gameVersion: 't', planTargetItemId: 6001, planTargetRate: 1 } };
    const violations = checkGeometry(layout, tall, at(3)).filter((v) => v.code === 'BUILDING_OVERLAP');
    expect(violations).toEqual([]);
    expect(checkGeometry(layout, tall, at(2)).filter((v) => v.code === 'BUILDING_OVERLAP')).toHaveLength(1);
  });
});

describe('a layout with lab stacks', () => {
  it('passes the full validator, simulation included, and makes the 2 matrices/s of 6 labs from 2 stacks of 3', async () => {
    const fx = at(3);
    const plan = await matrixPlan(2);
    const base = await matrixNetlist(2, fx);
    const net = applyMotifs(base, labStackMotif.propose(base, data, fx), data, fx);
    const { layout } = pipelineLayout(net, plan, 4, undefined, fx);

    const labs = layout.buildings.filter((b) => b.itemId === MATRIX_LAB);
    expect(labs).toHaveLength(6);
    expect(labs.filter((b) => b.z > 0)).toHaveLength(4);
    // only the bottom labs have sorters
    const stacked = new Set(labs.filter((b) => b.stackParentId !== undefined).map((b) => b.id));
    for (const s of layout.sorters) {
      for (const end of [s.pick, s.drop]) if (end.kind === 'building') expect(stacked.has(end.buildingId)).toBe(false);
    }
    const report = validateLayout(layout, plan, data, fx, { warmupTicks: 7200, measureTicks: 18000 });
    expect(report.violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99 * 2);
  });

  it('the same layout fails the capacity check when the validator is told labs may not stack that high', async () => {
    const plan = await matrixPlan(2);
    const base = await matrixNetlist(2, at(3));
    const net = applyMotifs(base, labStackMotif.propose(base, data, at(3)), data, at(3));
    const { layout } = pipelineLayout(net, plan, 4, undefined, at(3));
    const report = validateLayout(layout, plan, data, at(2), { simulate: false });
    expect(report.pass).toBe(false);
    expect(report.violations.map((v) => v.code)).toContain('BUILDING_OVERLAP');
  });
});
