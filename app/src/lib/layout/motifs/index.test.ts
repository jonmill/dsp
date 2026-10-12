import { describe, expect, it } from 'vitest';
import { sorterRate } from '../../validate/capacity';
import { netStack } from '../netlist';
import { data, effects, matrixNetlist, processorNetlist } from '../testkit';
import { directInsertionMotif } from './direct-insertion';
import { applyMotifs, enabledMotifKinds, MOTIFS, proposeMotifs, VERIFIED_MOTIFS } from './index';
import type { MotifInstance } from './index';

const at = (labLevel: number) => ({ ...effects, labLevel });

describe('the motif library', () => {
  it('has the three motifs, lab stacks first (they get their machines before the others)', () => {
    expect(MOTIFS.map((m) => m.kind)).toEqual(['labStack', 'direct', 'sandwich']);
  });

  it('ships with no motif verified; the user opts in to the rest', () => {
    expect(VERIFIED_MOTIFS.size).toBe(0);
    expect([...enabledMotifKinds(false)]).toEqual([]);
    expect([...enabledMotifKinds(true)].sort()).toEqual(['direct', 'labStack', 'sandwich']);
    // a verified motif is on whatever the option says
    expect([...enabledMotifKinds(false, new Set(['direct']))]).toEqual(['direct']);
    expect([...enabledMotifKinds(true, new Set(['direct']))].sort()).toEqual(['direct', 'labStack', 'sandwich']);
  });
});

describe('proposeMotifs', () => {
  it('proposes only the kinds it is asked for', async () => {
    const net = await matrixNetlist(2, at(3));
    expect(proposeMotifs(net, data, at(3), new Set())).toEqual([]);
    const stacks = proposeMotifs(net, data, at(3), new Set(['labStack']));
    expect(stacks.map((i) => i.kind)).toEqual(['labStack', 'labStack']);
  });

  it('hands out every machine once: a machine in a lab stack is in no other instance', async () => {
    const net = await matrixNetlist(2, at(3));
    const all = proposeMotifs(net, data, at(3), enabledMotifKinds(true));
    const ids = all.flatMap((i) => i.machineIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.filter((i) => i.kind === 'labStack')).toHaveLength(2);
  });
});

describe('applyMotifs with lab stacks', () => {
  it('moves the taps of the upper labs to the bottom lab: one tap per net and item, with the stack rate', async () => {
    const net = await matrixNetlist(2, at(3));
    const instances = proposeMotifs(net, data, at(3), new Set(['labStack']));
    const applied = applyMotifs(net, instances, data, at(3));
    const [a, b] = instances.map((i) => i.machineIds[0]);

    // 8 nets before and after: the stacks only change the taps
    expect(applied.nets).toHaveLength(net.nets.length);
    const coil = applied.nets.find((n) => n.itemId === 1202)!;
    const coilConsumers = coil.taps.filter((t) => t.dir === 'in');
    expect(coilConsumers.map((t) => t.machineId)).toEqual([a, b]);
    for (const t of coilConsumers) expect(t.rate).toBeCloseTo(1, 9);
    const matrices = applied.nets.find((n) => n.itemId === 6001)!;
    expect(matrices.taps.map((t) => [t.machineId, t.dir])).toEqual([[a, 'out'], [b, 'out']]);
    expect(matrices.rate).toBeCloseTo(2, 9);
    // the flow of the net is the same: nothing left the belts
    expect(applied.nets.map((n) => n.rate)).toEqual(net.nets.map((n) => n.rate));
  });

  it('gives every merged tap the sorters its rate needs: a stack of 6 on Mk.I sorters takes 2 where a lab alone takes 1', async () => {
    // Mk.I sorters move 1.5 items/s from a belt of stack 1 and from a building: 2 items/s take two of them
    const fx = { ...at(6), availableBuildings: new Set([...effects.availableBuildings].filter((id) => ![2012, 2013, 2014].includes(id))) };
    const net = await matrixNetlist(2, fx);
    expect(net.sorterTierItemId).toBe(2011);
    const lone = net.nets.find((n) => n.itemId === 1301)!.taps.find((t) => t.dir === 'in')!;
    expect(lone.sorters).toBe(1);

    const instances = proposeMotifs(net, data, fx, new Set(['labStack']));
    expect(instances.map((i) => i.machineIds.length)).toEqual([6]);
    const applied = applyMotifs(net, instances, data, fx);
    const leader = instances[0].machineIds[0];
    for (const itemId of [1202, 1301, 6001]) {
      const tap = applied.nets.find((n) => n.itemId === itemId)!.taps.find((t) => t.machineId === leader)!;
      expect(tap.rate).toBeCloseTo(2, 9);
      expect(tap.sorters).toBe(2);
    }
    // and every tap, merged or not, has exactly the sorters its rate implies on its own pick side
    for (const n of applied.nets) {
      const stack = netStack(n.source.kind === 'station', fx);
      for (const t of n.taps) {
        const per = sorterRate(applied.sorterTierItemId, 1, t.dir === 'in' ? stack : 0, fx, data);
        expect(t.sorters, `net ${n.id} ${t.machineId} ${t.dir}`).toBe(Math.max(1, Math.ceil(t.rate / per - 1e-9)));
      }
    }
  });

  it('records the groups for placement: leader first, the others on top of it', async () => {
    const net = await matrixNetlist(2, at(3));
    const instances = proposeMotifs(net, data, at(3), new Set(['labStack']));
    const applied = applyMotifs(net, instances, data, at(3));
    expect(applied.motifs!.groups).toHaveLength(2);
    const [g] = applied.motifs!.groups;
    expect(g.kind).toBe('labStack');
    expect(g.members.map((m) => [m.machineId, m.dz, m.onTop])).toEqual([
      [instances[0].machineIds[0], 0, undefined],
      [instances[0].machineIds[1], 3, instances[0].machineIds[0]],
      [instances[0].machineIds[2], 6, instances[0].machineIds[1]],
    ]);
    expect(applied.motifs!.sorters).toEqual([]);
  });

  it('leaves the base netlist alone, keeps its machines and stations, and renumbers nothing it did not drop', async () => {
    const net = await matrixNetlist(2, at(3));
    const before = JSON.stringify(net);
    const applied = applyMotifs(net, proposeMotifs(net, data, at(3), new Set(['labStack'])), data, at(3));
    expect(JSON.stringify(net)).toBe(before);
    expect(applied.machines).toEqual(net.machines);
    expect(applied.stations).toEqual(net.stations);
    expect(applied.nets.map((n) => n.id)).toEqual(net.nets.map((n) => n.id));
    expect(net.motifs).toBeUndefined();
  });

  it('skips an instance that shares a machine with an earlier one, and refuses a machine the netlist lacks', async () => {
    const net = await matrixNetlist(2, at(3));
    const [first] = proposeMotifs(net, data, at(3), new Set(['labStack']));
    const clash: MotifInstance = { ...first, machineIds: [first.machineIds[1], first.machineIds[2]] };
    const applied = applyMotifs(net, [first, clash], data, at(3));
    expect(applied.motifs!.groups).toHaveLength(1);
    expect(() => applyMotifs(net, [{ ...first, machineIds: [9999, 10000] }], data, at(3))).toThrow(/machine/);
  });

  it('applies nothing to the Processor netlist but returns a netlist of its own', async () => {
    const net = await processorNetlist();
    const applied = applyMotifs(net, [], data, effects);
    expect(applied.nets).toEqual(net.nets);
    expect(applied.motifs).toEqual({ groups: [], sorters: [] });
  });
});

describe('applyMotifs with direct insertion', () => {
  it('takes the satisfied taps off their nets, drops a net that is left with none, and records the sorters', async () => {
    const net = await matrixNetlist(2);
    const instances = directInsertionMotif.propose(net, data, effects);
    expect(instances).toHaveLength(2);
    const applied = applyMotifs(net, instances, data, effects);
    // iron ingots and magnets went straight from smelter to assembler: their nets are gone, the rest are numbered from 1
    expect(applied.nets.map((n) => n.itemId)).toEqual(net.nets.map((n) => n.itemId).filter((i) => i !== 1101 && i !== 1102));
    expect(applied.nets.map((n) => n.id)).toEqual(applied.nets.map((_, i) => i + 1));
    expect(applied.motifs!.sorters).toHaveLength(2);
    for (const s of applied.motifs!.sorters) expect(s.plannedRate).toBeCloseTo(2, 9);
    // the machines that were linked no longer tap what they exchange
    const linked = new Set(instances.flatMap((i) => i.machineIds));
    for (const n of applied.nets) {
      for (const t of n.taps.filter((t) => linked.has(t.machineId))) expect([1101, 1102]).not.toContain(t.itemId);
    }
  });

  it('keeps the flows of what stays: every net has supply for its demand', async () => {
    const net = await matrixNetlist(2);
    const applied = applyMotifs(net, directInsertionMotif.propose(net, data, effects), data, effects);
    for (const n of applied.nets) {
      if (n.source.kind !== 'taps') continue;
      const supply = n.taps.filter((t) => t.dir === 'out').reduce((s, t) => s + t.rate, 0);
      expect(supply).toBeCloseTo(n.rate, 9);
    }
  });

  it('refuses taps that do not balance (a bug in a motif, not something to pave over)', async () => {
    const net = await matrixNetlist(2);
    const [pair] = directInsertionMotif.propose(net, data, effects);
    const lopsided: MotifInstance = { ...pair, satisfiesNets: pair.satisfiesNets.map((s) => ({ ...s, machineIds: [s.machineIds[0]] })) };
    expect(() => applyMotifs(net, [lopsided], data, effects)).toThrow(/do not balance/);
  });
});
