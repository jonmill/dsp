import { describe, expect, it } from 'vitest';
import { buildingDef, buildingOBBs, obbOverlap, slotInfos, sorterTapPoint } from '../../geometry';
import type { Layout, PlacedBuilding } from '../../geometry';
import { checkGeometry, validateLayout } from '../../validate';
import { ASSEMBLER, data, effects, pipelineLayout, processorNetlist, processorPlan, SMELTER } from '../testkit';
import { applyMotifs } from './apply';
import { sandwichMotif, sandwichSpacing } from './sandwich';

describe('sandwichSpacing', () => {
  it('is the row pitch and row gap of MX §9 M1: smelters 3 tiles apart, assemblers 4, rows 4 tiles apart', () => {
    expect(sandwichSpacing(SMELTER, data, effects)).toEqual({ pitch: 3, gap: 4 });
    expect(sandwichSpacing(ASSEMBLER, data, effects)).toEqual({ pitch: 4, gap: 4 });
  });

  it('the pitch is the smallest whole offset at which two machines of a row do not overlap', () => {
    for (const item of [SMELTER, ASSEMBLER, 2309]) {
      const { pitch } = sandwichSpacing(item, data, effects)!;
      const def = buildingDef(data, item);
      const at = (x: number): PlacedBuilding => ({ id: x + 1, itemId: item, x, y: 0, z: 0, yaw: 0 });
      const overlap = (x: number): boolean => buildingOBBs(at(0), def).some((a) => buildingOBBs(at(x), def).some((b) => obbOverlap(a, b)));
      expect(overlap(pitch)).toBe(false);
      for (let x = 1; x < pitch; x++) expect(overlap(x), `${item} at ${x}`).toBe(true);
    }
  });

  it('puts the tap points of the two rows on one lattice row: a slot of each, facing the other, taps the same point', () => {
    for (const item of [SMELTER, ASSEMBLER]) {
      const { gap } = sandwichSpacing(item, data, effects)!;
      const def = buildingDef(data, item);
      const lower = slotInfos({ id: 1, itemId: item, x: 0, y: 0, z: 0, yaw: 0 }, def);
      const upper = slotInfos({ id: 2, itemId: item, x: 0, y: gap, z: 0, yaw: 180 }, def);
      const lowerTaps = lower.filter((s) => s.dir[1] === 1).map((s) => sorterTapPoint(s, 1));
      const upperTaps = upper.filter((s) => s.dir[1] === -1).map((s) => sorterTapPoint(s, 1));
      expect(lowerTaps.length).toBeGreaterThan(0);
      const shared = lowerTaps.filter((p) => upperTaps.some((q) => q.x === p.x && q.y === p.y));
      expect(shared).toHaveLength(3); // all three slots of the facing sides share a node with the other row
      expect(new Set(shared.map((p) => p.y)).size).toBe(1); // on one row, which is half the gap up
    }
  });

  it('is cached, and gives up on a building that cannot share a belt row', () => {
    expect(sandwichSpacing(SMELTER, data, effects)).toBe(sandwichSpacing(SMELTER, data, effects));
    expect(sandwichSpacing(2308, data, effects)).toBeUndefined(); // the refinery: its slots do not line up across a gap
  });
});

describe('sandwichMotif.propose', () => {
  it('makes modules of two mirrored rows from the machines of a stage, in id order (the Processor\'s 8 silicon smelters: 3+3 and 1+1)', async () => {
    const net = await processorNetlist(1);
    const found = sandwichMotif.propose(net, data, effects);
    const silicon = net.machines.filter((m) => m.stageIndex === 5).map((m) => m.id);
    expect(silicon).toHaveLength(8);
    const modules = found.filter((i) => i.machineIds.every((id) => silicon.includes(id)));
    expect(modules.map((i) => i.machineIds)).toEqual([silicon.slice(0, 6), silicon.slice(6)]);
    const [big, small] = modules;
    expect(big.relative.map((r) => [r.dx, r.dy, r.yaw])).toEqual([[0, 0, 0], [3, 0, 0], [6, 0, 0], [0, 4, 180], [3, 4, 180], [6, 4, 180]]);
    expect(small.relative.map((r) => [r.dx, r.dy, r.yaw])).toEqual([[0, 0, 0], [0, 4, 180]]);
    for (const m of found) {
      expect(m.kind).toBe('sandwich');
      expect(m.anchor).toEqual({ x: 0, y: 0, yaw: 0 });
      expect(m.internalSorters).toEqual([]);
      expect(m.satisfiesNets).toEqual([]);
      expect(m.relative[0]).toMatchObject({ machineId: m.machineIds[0], dx: 0, dy: 0, dz: 0, yaw: 0 });
    }
  });

  it('keeps the machines of a module in one stage, and no machine twice', async () => {
    const net = await processorNetlist(1);
    const found = sandwichMotif.propose(net, data, effects);
    const ids = found.flatMap((i) => i.machineIds);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of found) expect(new Set(m.machineIds.map((id) => net.machines[id - 1].stageIndex)).size).toBe(1);
  });

  it('leaves out machines that are taken, and a stage with a single machine left makes no module', async () => {
    const net = await processorNetlist(1);
    const iron = net.machines.filter((m) => m.stageIndex === 3).map((m) => m.id); // 2 smelters
    expect(sandwichMotif.propose(net, data, effects).some((i) => i.machineIds.includes(iron[0]))).toBe(true);
    const found = sandwichMotif.propose(net, data, effects, new Set([iron[0]]));
    expect(found.some((i) => i.machineIds.some((id) => iron.includes(id)))).toBe(false);
  });

  it('looks machines up by id, not by position: ids that do not run from 1 make the same modules', async () => {
    const net = await processorNetlist(1);
    const shifted = { ...net, machines: net.machines.slice().reverse().map((m) => ({ ...m, id: m.id + 500 })) };
    const found = sandwichMotif.propose(shifted, data, effects);
    const plain = sandwichMotif.propose(net, data, effects);
    expect(found.map((i) => i.machineIds)).toEqual(plain.map((i) => i.machineIds.map((id) => id + 500)));
  });

  it('a module is geometrically clean on its own: the validator finds no overlap and nothing else wrong with the buildings', async () => {
    const net = await processorNetlist(1);
    for (const m of sandwichMotif.propose(net, data, effects)) {
      const buildings: PlacedBuilding[] = m.relative.map((r) => ({
        id: r.machineId, itemId: net.machines[r.machineId - 1].buildingItemId, x: 40 + r.dx, y: 40 + r.dy, z: 0, yaw: r.yaw,
      }));
      const layout: Layout = { buildings, belts: [], sorters: [], meta: { geometrySource: 'approximate', gameVersion: 't', planTargetItemId: 0, planTargetRate: 0 } };
      expect(checkGeometry(layout, data, effects).filter((v) => !/^POWER_/.test(v.code))).toEqual([]);
    }
  });

  it('the rows of a module do not overlap, at pitch and gap', async () => {
    const net = await processorNetlist(1);
    for (const m of sandwichMotif.propose(net, data, effects)) {
      const buildings: PlacedBuilding[] = m.relative.map((r) => ({
        id: r.machineId, itemId: net.machines[r.machineId - 1].buildingItemId, x: r.dx, y: r.dy, z: 0, yaw: r.yaw,
      }));
      const obbs = buildings.map((b) => buildingOBBs(b, buildingDef(data, b.itemId)));
      for (let i = 0; i < obbs.length; i++) for (let j = i + 1; j < obbs.length; j++) {
        expect(obbs[i].some((a) => obbs[j].some((b) => obbOverlap(a, b))), `${m.machineIds[i]} and ${m.machineIds[j]}`).toBe(false);
      }
    }
  });
});

describe('a layout with sandwiches', () => {
  it('passes the full validator for the Processor with every stage in modules', async () => {
    const plan = await processorPlan(1);
    const base = await processorNetlist(1);
    const net = applyMotifs(base, sandwichMotif.propose(base, data, effects), data, effects);
    expect(net.nets).toEqual(base.nets); // nothing leaves the belts
    const { layout } = pipelineLayout(net, plan, 4);
    const report = validateLayout(layout, plan, data, effects);
    expect(report.violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
    expect(report.pass).toBe(true);
  });
});
