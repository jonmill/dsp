import { describe, expect, it } from 'vitest';
import { buildNetlist } from '../netlist';
import type { NetTap, Netlist } from '../netlist';
import { checkGeometry, validateLayout } from '../../validate';
import { sorterRate } from '../../validate/capacity';
import type { Layout, PlacedBuilding, Sorter } from '../../geometry';
import { ASSEMBLER, data, effects, matrixNetlist, matrixPlan, pipelineLayout, planFor, processorNetlist, SMELTER, synthNetlist } from '../testkit';
import { applyMotifs } from './apply';
import { directInsertionMotif, linkPoses } from './direct-insertion';
import type { MotifInstance } from './types';

/** 1 Magnetic Coil/s on base-tier machines: one assembler, three smelters (two for magnets, one for copper). */
const coilPlan = () =>
  planFor({
    targetItemId: 1202,
    suppliedItemIds: new Set([1001, 1002]),
    finalFacilityItemId: ASSEMBLER,
    facilityOverrides: { 6: ASSEMBLER, 1: SMELTER, 2: SMELTER, 3: SMELTER },
  });
const coilNetlist = async (): Promise<Netlist> => buildNetlist(await coilPlan(), data, effects);

/** The machines of `instance`, as the buildings of a layout with the instance's sorters (the anchor at (40, 40)). */
function layoutOfInstance(net: Netlist, instance: MotifInstance): Layout {
  const itemOf = new Map(net.machines.map((m) => [m.id, m.buildingItemId] as const));
  const buildings: PlacedBuilding[] = instance.relative.map((r) => ({
    id: r.machineId,
    itemId: itemOf.get(r.machineId) as number,
    x: 40 + r.dx,
    y: 40 + r.dy,
    z: r.dz,
    yaw: r.yaw,
  }));
  const sorters: Sorter[] = instance.internalSorters.map((s, i) => ({
    id: i + 1,
    tierItemId: net.sorterTierItemId,
    filterItemId: s.itemId,
    span: s.span,
    pick: { kind: 'building', buildingId: s.fromMachine, slot: s.fromSlot },
    drop: { kind: 'building', buildingId: s.toMachine, slot: s.toSlot },
    plannedRate: s.plannedRate,
  }));
  return { buildings, belts: [], sorters, meta: { geometrySource: 'approximate', gameVersion: 't', planTargetItemId: 0, planTargetRate: 0 } };
}

const geometryOnly = (layout: Layout) => checkGeometry(layout, data, effects).filter((v) => !/^(POWER_|STATION_)/.test(v.code));

describe('linkPoses', () => {
  it('finds poses of an assembler beside a smelter whose facing slots a sorter can join, smallest first', () => {
    const poses = linkPoses(2302, 2303, data, effects);
    expect(poses.length).toBeGreaterThan(0);
    expect(poses.length).toBeLessThanOrEqual(40);
    const area = (p: (typeof poses)[number]) => {
      const x0 = Math.min(-1.19, p.bounds.minX);
      const x1 = Math.max(1.19, p.bounds.maxX);
      const y0 = Math.min(-1.19, p.bounds.minY);
      const y1 = Math.max(1.19, p.bounds.maxY);
      return (x1 - x0) * (y1 - y0);
    };
    for (let i = 1; i < poses.length; i++) expect(area(poses[i])).toBeGreaterThanOrEqual(area(poses[i - 1]) - 1e-9);
    // the closest the two stand: an assembler is 4 tiles from a smelter's centre (the first lattice points outside meet)
    expect(Math.abs(poses[0].dx) + Math.abs(poses[0].dy)).toBe(4);
    expect(poses[0].pairs[0].span).toBe(1);
  });

  it('every pair of every pose is a sorter the validator accepts', () => {
    for (const [a, b] of [[2302, 2303], [2303, 2303], [2303, 2302]] as const) {
      for (const pose of linkPoses(a, b, data, effects)) {
        for (const pair of pose.pairs) {
          const buildings: PlacedBuilding[] = [
            { id: 1, itemId: a, x: 0, y: 0, z: 0, yaw: 0 },
            { id: 2, itemId: b, x: pose.dx, y: pose.dy, z: 0, yaw: pose.yaw },
          ];
          const sorter: Sorter = {
            id: 1, tierItemId: 2011, filterItemId: 0, span: pair.span, plannedRate: 0,
            pick: { kind: 'building', buildingId: 1, slot: pair.centreSlot }, drop: { kind: 'building', buildingId: 2, slot: pair.otherSlot },
          };
          const layout: Layout = { buildings, belts: [], sorters: [sorter], meta: { geometrySource: 'approximate', gameVersion: 't', planTargetItemId: 0, planTargetRate: 0 } };
          expect(geometryOnly(layout), `${a}/${b} at ${pose.dx},${pose.dy} yaw ${pose.yaw} slots ${pair.centreSlot}/${pair.otherSlot}`).toEqual([]);
        }
      }
    }
  });

  it('is cached: the same answer, the same objects', () => {
    expect(linkPoses(2302, 2303, data, effects)).toBe(linkPoses(2302, 2303, data, effects));
  });
});

describe('directInsertionMotif.propose', () => {
  it('links a coil assembler to the three smelters that feed it on two nets: one cluster of four machines', async () => {
    const net = await coilNetlist();
    const found = directInsertionMotif.propose(net, data, effects);
    expect(found).toHaveLength(1);
    const [c] = found;
    expect(c.kind).toBe('direct');
    expect(c.machineIds).toHaveLength(4);
    const coilAsm = net.machines.find((m) => m.buildingItemId === ASSEMBLER)!.id;
    expect(c.machineIds[0]).toBe(coilAsm);
    expect(c.anchor).toEqual({ x: 0, y: 0, yaw: 0 });
    expect(c.relative[0]).toEqual({ machineId: coilAsm, dx: 0, dy: 0, dz: 0, yaw: 0 });
    // magnets (2 smelters) and copper (1) both go straight in
    const itemOfNet = (id: number) => net.nets.find((n) => n.id === id)!.itemId;
    expect(c.satisfiesNets.map((s) => [itemOfNet(s.netId), s.machineIds.length]).sort()).toEqual([[1102, 3], [1104, 2]]);
    expect(c.internalSorters.map((s) => s.itemId).sort()).toEqual([1102, 1102, 1104]);
    for (const s of c.internalSorters) {
      expect(s.toMachine).toBe(coilAsm);
      expect(s.plannedRate).toBeCloseTo(0.5, 9);
      expect(s.plannedRate).toBeLessThanOrEqual(sorterRate(net.sorterTierItemId, s.span, 0, effects, data));
    }
    // each slot is used once
    const slots = c.internalSorters.flatMap((s) => [`${s.fromMachine}:${s.fromSlot}`, `${s.toMachine}:${s.toSlot}`]);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('proposes an arrangement that passes the validator\'s geometry rules', async () => {
    const net = await coilNetlist();
    const [c] = directInsertionMotif.propose(net, data, effects);
    expect(geometryOnly(layoutOfInstance(net, c))).toEqual([]);
  });

  it('what the cluster takes off the belts balances: the nets of the coil plan are gone, ore and coils stay', async () => {
    const net = await coilNetlist();
    const applied = applyMotifs(net, directInsertionMotif.propose(net, data, effects), data, effects);
    expect(applied.nets.map((n) => n.itemId)).toEqual([1001, 1002, 1202]);
    expect(applied.motifs!.sorters).toHaveLength(3);
    expect(applied.motifs!.groups).toHaveLength(1);
  });

  it('chooses the two pairs of the matrix plan (4 taps off the belts) over the copper smelter feeding both assemblers (3)', async () => {
    const net = await matrixNetlist(2);
    const found = directInsertionMotif.propose(net, data, effects);
    expect(found.map((i) => i.machineIds.length)).toEqual([2, 2]);
    expect(found.map((i) => new Set(i.internalSorters.map((s) => s.itemId)).size)).toEqual([1, 1]);
    expect(found.flatMap((i) => i.internalSorters.map((s) => s.itemId)).sort()).toEqual([1101, 1102]);
    for (const c of found) expect(geometryOnly(layoutOfInstance(net, c))).toEqual([]);
  });

  it('finds a cluster in the Processor netlist: the circuit board assembler with both iron smelters and a copper smelter', async () => {
    const net = await processorNetlist(1);
    const found = directInsertionMotif.propose(net, data, effects);
    expect(found).toHaveLength(1);
    expect(found[0].machineIds).toHaveLength(4);
    expect(found[0].satisfiesNets).toHaveLength(2);
    expect(geometryOnly(layoutOfInstance(net, found[0]))).toEqual([]);
  });

  it('proposes nothing where no producers and consumers balance (3 Gears/s on four assemblers and three smelters)', async () => {
    const plan = await planFor({
      targetItemId: 1201,
      suppliedItemIds: new Set([1001]),
      finalFacilityItemId: ASSEMBLER,
      facilityOverrides: { 5: ASSEMBLER, 1: SMELTER },
      quantity: { kind: 'rate', perSecond: 3 },
    });
    expect(directInsertionMotif.propose(buildNetlist(plan, data, effects), data, effects)).toEqual([]);
  });

  it('leaves out machines that are taken', async () => {
    const net = await coilNetlist();
    const [c] = directInsertionMotif.propose(net, data, effects);
    const got = directInsertionMotif.propose(net, data, effects, new Set([c.machineIds[2]]));
    for (const i of got) expect(i.machineIds).not.toContain(c.machineIds[2]);
    // without the third smelter the assembler still links to the other three machines, though: a smaller cluster
    expect(got.length).toBeLessThanOrEqual(1);
  });

  it('gives a link that is too fast for one sorter as many pairs of slots as it needs', () => {
    const tap = (machineId: number, dir: NetTap['dir'], rate: number): NetTap => ({ machineId, itemId: 1101, dir, rate, sorters: 3 });
    const net = synthNetlist(
      [{ building: ASSEMBLER, count: 2 }],
      [],
      [{ taps: [tap(1, 'out', 3), tap(2, 'in', 3)], rate: 3 }],
      2011, // Mk.I: 1.5 items/s from a building, so 3/s takes two
    );
    const [c] = directInsertionMotif.propose(net, data, effects);
    expect(c.internalSorters).toHaveLength(2);
    expect(c.internalSorters.reduce((s, x) => s + x.plannedRate, 0)).toBeCloseTo(3, 9);
    expect(new Set(c.internalSorters.map((s) => s.fromSlot)).size).toBe(2);
    expect(new Set(c.internalSorters.map((s) => s.toSlot)).size).toBe(2);
    expect(geometryOnly(layoutOfInstance(net, c))).toEqual([]);
    // 12/s would take eight Mk.I sorters, which no pair of faces has room for
    const heavy = synthNetlist(
      [{ building: ASSEMBLER, count: 2 }],
      [],
      [{ taps: [tap(1, 'out', 12), tap(2, 'in', 12)], rate: 12 }],
      2011,
    );
    expect(directInsertionMotif.propose(heavy, data, effects)).toEqual([]);
  });
});

describe('a layout with a direct-insertion cluster', () => {
  it('passes the full validator, simulation included, with the cluster\'s sorters between buildings', async () => {
    const plan = await coilPlan();
    const base = buildNetlist(plan, data, effects);
    const net = applyMotifs(base, directInsertionMotif.propose(base, data, effects), data, effects);
    const { layout } = pipelineLayout(net, plan, 3);
    const between = layout.sorters.filter((s) => s.pick.kind === 'building' && s.drop.kind === 'building');
    expect(between).toHaveLength(3);
    for (const s of between) expect(s.filterItemId).toBeGreaterThan(0);
    // two belts fewer than without the cluster
    expect(layout.belts).toHaveLength(base.nets.length - 2);
    const report = validateLayout(layout, plan, data, effects, { warmupTicks: 3600, measureTicks: 18000 });
    expect(report.violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99 * 1);
  });

  it('works for the pairs of the matrix plan too', async () => {
    const plan = await matrixPlan(2);
    const base = await matrixNetlist(2);
    const net = applyMotifs(base, directInsertionMotif.propose(base, data, effects), data, effects);
    const { layout } = pipelineLayout(net, plan, 4);
    const report = validateLayout(layout, plan, data, effects, { warmupTicks: 7200, measureTicks: 18000 });
    expect(report.violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
    expect(report.pass).toBe(true);
  });
});
