import { describe, expect, it } from 'vitest';
import { checkGeometry } from '../validate/geometry-checks';
import type { Netlist } from './netlist';
import { constructivePlacement } from './placement';
import { defaultRouteParams, routeNets } from './router';
import type { RoutedNet } from './router';
import { assignTaps } from './taps';
import type { AssignedTap } from './taps';
import { data, effects, layoutOf, occupancyOf, processorNetlist, quantumNetlist } from './testkit';

/** Per net: a consumer upstream of a producer on the belt is short of supply. */
function consumersUpstream(taps: AssignedTap[], routes: RoutedNet[]): string[] {
  const out: string[] = [];
  for (const r of routes) {
    const at = (t: AssignedTap): number => r.nodes.findIndex((p) => p.x === t.point.x && p.y === t.point.y && p.z === 0);
    const mine = taps.filter((t) => t.netId === r.netId);
    const producers = mine.filter((t) => t.dir === 'out').map(at);
    const consumers = mine.filter((t) => t.dir === 'in').map(at);
    if (producers.length > 0 && consumers.length > 0 && Math.min(...consumers) < Math.max(...producers)) {
      out.push(`net ${r.netId}: a consumer at node ${Math.min(...consumers)} is upstream of a producer at node ${Math.max(...producers)}`);
    }
  }
  return out;
}

/** Placement, taps, routes and the validator's verdict on the BELT, SORTER and BUILDING rules. */
function solve(net: Netlist, margin: number) {
  const placement = constructivePlacement(net, data, margin);
  const occ = occupancyOf(placement.buildings);
  const taps = assignTaps(net, placement, occ, data, effects);
  if ('failed' in taps) throw new Error(`assignTaps failed: ${taps.failed}`);
  const t0 = performance.now();
  const res = routeNets(net, taps, occ, defaultRouteParams(occ), () => false);
  const ms = performance.now() - t0;
  process.stdout.write(`route: ${net.nets.length} nets, ${net.machines.length} machines, ${ms.toFixed(0)} ms\n`);
  const layout = layoutOf(net, placement, taps, res.routes);
  const bad = checkGeometry(layout, data, effects)
    .filter((v) => /^(BELT_|SORTER_|BUILDING_)/.test(v.code))
    .map((v) => `${v.code}: ${v.message}`);
  return { res, taps, layout, bad, upstream: consumersUpstream(taps.taps, res.routes) };
}

describe('tap assignment and routing end to end', () => {
  it('the Processor netlist on the constructive placement (margin 2) passes the BELT and SORTER rules', async () => {
    const net = await processorNetlist();
    const { res, taps, layout, bad, upstream } = solve(net, 2);
    expect(res.ok, `conflicts: ${res.ok ? 0 : res.conflicts}`).toBe(true);
    expect(res.routes.every((r) => r.nodes.length > 1)).toBe(true);
    expect(bad).toEqual([]);
    expect(upstream).toEqual([]);
    expect(layout.sorters.length).toBe(taps.taps.length);
  }, 120_000);

  it('a larger Processor netlist (6 per second) converges and passes the rules too', async () => {
    const { res, bad, upstream } = solve(await processorNetlist(6), 2);
    expect(res.ok, `conflicts: ${res.ok ? 0 : res.conflicts}`).toBe(true);
    expect(bad).toEqual([]);
    expect(upstream).toEqual([]);
  }, 120_000);

  it('a 231-machine Quantum Chip netlist converges and passes the rules (with taps at span 2)', async () => {
    const { res, taps, bad, upstream } = solve(await quantumNetlist(), 2);
    expect(res.ok, `conflicts: ${res.ok ? 0 : res.conflicts}`).toBe(true);
    expect(bad).toEqual([]);
    expect(upstream).toEqual([]);
    expect(taps.taps.some((t) => t.span === 2)).toBe(true);
  }, 300_000);
});
