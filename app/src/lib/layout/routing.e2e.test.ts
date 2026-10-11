import { describe, expect, it } from 'vitest';
import type { Netlist } from './netlist';
import { checkGeometry } from '../validate/geometry-checks';
import { constructivePlacement } from './placement';
import { defaultRouteParams, routeNets } from './router';
import { assignTaps } from './taps';
import { data, effects, layoutOf, occupancyOf, processorNetlist, quantumNetlist } from './testkit';

/** Placement, taps, routes and the validator's verdict on the BELT, SORTER and BUILDING rules. */
function solve(net: Netlist, margin: number) {
  const placement = constructivePlacement(net, data, margin);
  const occ = occupancyOf(placement.buildings);
  const taps = assignTaps(net, placement, occ, data, effects);
  if ('failed' in taps) throw new Error(`assignTaps failed: ${taps.failed}`);
  const t0 = performance.now();
  const res = routeNets(net, taps, occ, defaultRouteParams(occ), () => false);
  const ms = performance.now() - t0;
  const layout = layoutOf(net, placement, taps, res.routes);
  const bad = checkGeometry(layout, data, effects)
    .filter((v) => /^(BELT_|SORTER_|BUILDING_)/.test(v.code))
    .map((v) => `${v.code}: ${v.message}`);
  return { res, taps, layout, bad, ms };
}

describe('tap assignment and routing end to end', () => {
  it('a larger Processor netlist (6 per second) converges and passes the rules too', async () => {
    const net = await processorNetlist(6);
    const { res, bad, ms } = solve(net, 2);
    process.stdout.write(`route: ${net.nets.length} nets, ${net.machines.length} machines, ${ms.toFixed(0)} ms\n`);
    expect(res.ok, `conflicts: ${res.ok ? 0 : res.conflicts}`).toBe(true);
    expect(bad).toEqual([]);
  }, 120_000);

  it('a 231-machine Quantum Chip netlist converges and passes the rules (with taps at span 2)', async () => {
    const net = await quantumNetlist();
    const { res, taps, bad, ms } = solve(net, 2);
    process.stdout.write(`route: ${net.nets.length} nets, ${net.machines.length} machines, ${ms.toFixed(0)} ms\n`);
    expect(res.ok, `conflicts: ${res.ok ? 0 : res.conflicts}`).toBe(true);
    expect(bad).toEqual([]);
    expect(taps.taps.some((t) => t.span === 2)).toBe(true);
  }, 300_000);

  it('the Processor netlist on the constructive placement (margin 2) passes the BELT and SORTER rules', async () => {
    const net = await processorNetlist();
    const placement = constructivePlacement(net, data, 2);
    const occ = occupancyOf(placement.buildings);

    const taps = assignTaps(net, placement, occ, data, effects);
    if ('failed' in taps) throw new Error(`assignTaps failed: ${taps.failed}`);

    const t0 = performance.now();
    const res = routeNets(net, taps, occ, defaultRouteParams(occ), () => false);
    const ms = performance.now() - t0;
    process.stdout.write(`route: ${net.nets.length} nets, ${net.machines.length} machines, ${ms.toFixed(0)} ms\n`);
    expect(res.ok, `conflicts: ${res.ok ? 0 : res.conflicts}`).toBe(true);
    expect(res.routes.every((r) => r.nodes.length > 1)).toBe(true);

    const layout = layoutOf(net, placement, taps, res.routes);
    const violations = checkGeometry(layout, data, effects);
    const bad = violations.filter((v) => /^(BELT_|SORTER_|BUILDING_)/.test(v.code));
    expect(bad.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
    expect(layout.sorters.length).toBe(taps.taps.length);
  }, 120_000);
});
