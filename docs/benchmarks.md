# Solver benchmarks

Produced by `npm run bench -- --budget 60 --plans processor,quantum-chip,circuit-board,smelter-row` (`app/scripts/bench.ts`).
Each row is one plan on one run of the solver with the fixture data, one thread, seed 1 unless the label says otherwise, the
early stop off (so the whole budget is used), motifs off. Times are wall-clock on the machine that ran it, so compare rows
of one machine only. A run does not repeat: the annealer makes as many moves as the time allows, so the footprint of a run
varies by 10-20 % with the seed and the load; compare means over several `--seed`s.

- **First valid**: seconds from the start of `solve` to the first layout that passed the full validator (placement, taps,
  routing, power, static checks and the tick simulation). The fallback ladder is not bound by the budget, so this can exceed it.
- **First from**: the ladder margin that made it. **First rate**: its simulated target rate over the rate asked for (the gate is 0.99).
- **Best footprint**: tiles (area of the box around everything) of the best layout when the budget ran out.
- **Validated**: candidates that passed the static checks; **attempts**: candidates built (ladder rungs and improvement iterations).

Plans: `processor` 1 Processor/s on Mk.III assemblers; `quantum-chip` 1 Quantum Chip/s on base-tier machines from raw resources;
`circuit-board` 1 Circuit Board/s; `smelter-row` 12 Iron Ingots/s; `pls` Planetary Logistics Station/s (ladder regression check).

## Task 27: what changed, and what it measured

"Before" is the commit before the task (723fb7c); "after" is the commit named in the row (the last code commit of the task: 95b6851). The rows
labelled "paired" were run beside their counterpart (the same seed, before and after at once, two processes on one machine); the
others ran alone. All runs are wall-clock bound, so they vary with the seed and the machine's load: the footprint of a 60 s run
varies by 10-20 % from seed to seed, and a Quantum Chip run has only four to eight improvement iterations in its budget, so one
lucky or unlucky iteration decides it. Read the time to the first valid layout, the validated count and the ladder's time as
measurements, and the best footprints as "no worse".

| Measure | Before (723fb7c) | After (95b6851) |
| --- | --- | --- |
| Quantum Chip, first valid layout (alone, seed 1) | 7.8 s | 3.2 s |
| Quantum Chip, first valid layout (three seeds, paired) | 8.1-8.3 s | 3.2-3.3 s |
| Quantum Chip, best footprint after 60 s (three seeds, paired; mean) | 24931 tiles | 23799 tiles |
| Planetary Logistics Station, ladder to the first valid layout (`pls` row; margin 6, 0.990 of the rate) | 111.0 s | 56.4 s |
| Ladder sweep, 102 items, plain `validateLayout` (alone) | 202 s | 108 s |
| Processor, best footprint after 60 s (eight seeds, eight runs at once; mean; after = 3cc70f9) | 703 tiles | 704 tiles |
| Smelter Row, best footprint after 60 s (the same) | 430 tiles | 424 tiles |
| Processor, candidates that passed the static checks in 60 s (alone, seed 1) | 32 of 86 | 80 of 121 |
| Circuit Board, the same | 492 of 991 | 731 of 875 |

### Routing (router.ts), measured on annealed placements (8-12 per plan and margin) and the ladder's constructive ones

"Routed" counts the layouts of a set that came out with no shared cell and no net without a route; the sets are Processor and
Smelter Row at margins 1 and 2 and the Quantum Chip at margin 2, 48 layouts in all, routed the way the improvement loop does.

| Setting | Tried | Result | Kept |
| --- | --- | --- | --- |
| A* heuristic weight | 1, 1.15, 1.25, 1.4, 1.5, 2 | Quantum Chip, margin 2: 3.8 s, -, 0.9 s, -, 0.36 s, 0.15 s a layout; 14.3k nodes at 1 and 1.25; elevated nodes 3.2k, -, 3.5k, -, 5.7k, 6.2k. Planetary Logistics Station routing at margin 3: 27 s to 7 s. Routed of the 48: 24, 26, 27, 22 at 1, 1.15, 1.25, 1.4 | 1.25 |
| Elevation cost per level | 0.25, 0.5, 1, 2, 4 | 1, 2 and 4 lift 16, 23 and 27 % fewer nodes of the ladder's Quantum Chip layouts, for 3, 8 and 14 % more nodes in all and 2.3, 4.5 and 7 times the time; annealed Quantum Chip placements routed (of 8): 5 at 0.25, 5 at 0.5, 0 at 1 and 2 | 0.5 (unchanged) |
| Highest belt level | 1, 2, 3 | routed of the 48: 17, 28, 27; level 3 takes 1.2-1.5 times as long | 2 (unchanged) |
| Bonus for a step beside a parallel belt of another net ("reuse parallel lanes") | 0, 0.15, 0.3 | routed of the 48: 28, 23, 26; the box around buildings and belts did not get smaller | none |
| A box around each leg's stops, searched first | none, 6, 12, 20 tiles | routed of the 48: 27, 22, 28, 26; time within 10 %; Planetary Logistics Station unchanged | none |
| Searches of one net that may fail in a row | 3, 6, no cap | 3 lost one Processor layout (11 of 12 at margin 2); 6 lost none, and took 13.5 s for the four small sets that took 20.5 s with rerouting and no cap | 5 |
| Rerouting a failed net with its stops in another order | not, twice | Processor annealed at margin 1: 0 to 2 routed of 12; Smelter Row: 0 to 1 of 8; the sink-port trap of the router tests (a belt walls in its own sink port; the weighted heuristic makes it happen) is routed | 2 |
| Give up a negotiation after n rounds in a row without a better round (improvement loop only) | 3, 4, 6, 10 (and 16, 24, 40) | routed of the 48: 23, 25, 25, 26; time 63, 66, 71, 79 s; 10, 16, 24 and 40 route the same 28 of 55 in 299, 360, 365 and 366 s | 10 |
| Give up after round 6 above 4 conflicts per net (improvement loop only) | - | Quantum Chip annealed at margin 1 has 400-650 conflicts at round 6 for 56 nets and never converges (25 s a try); those that converge have 2 per net or fewer | 6 rounds, 4 per net |

Margin 1 on the annealed placements routes 0 of 7 for the Quantum Chip (31-40 s a try), 1 of 12 for the Processor and 2 of 8 for
the Smelter Row; margin 2 routes 5 of 8, 12 of 12 and 8 of 8. The improvement loop therefore picks its margin by what got built
(`MarginPicker`, 15 % at least for the worse one). On annealed Quantum Chip placements failing A* legs (226, each exhausting the
whole window, about 1.1M expansions) cost 57 % of all expansions, and 0.1 % of the successful legs also take 0.9-1.1M: a cheaper
proof that a leg is infeasible is the next speed-up for large plans (a flood fill does not give it: 98 % of the failing legs are
reachable when headings and phases are ignored).

### Improvement loop (solver.ts)

* Reheating: an anneal that has all the moves it can use starts at 1 + 0.25 per iteration since its chain's last improvement
  times the base temperature, to 8 times. Processor mean footprint after 60 s over 8 seeds (six runs at once): none 805, 0.25 up
  to 8 705, 0.1 up to 3 798; Smelter Row 463, 424, 439. Without it the best layout of a 60 s Processor run is mostly the one found within 30 s.
  Against the commit before the task the effect is to bring the loop back to the same footprints (703 and 430): the faster
  router, the margin picker and the give-up rules cost the small plans about as much as reheating gains (ablations over 8 seeds,
  no reheating: 798; uniform margins 754; no give-up rules 742; exact heuristic in the loop 748; no rerouting 842).
* A candidate's simulation waits for twice the best layout's warm-up (at least four windows) instead of 72000 ticks, but only
  when that is at most half the limit (a Quantum Chip layout settles after 32400 ticks in one run and never in the next), and
  it ends when the budget does.
* The ladder keeps a layout that passed only over the doubled measure window of a near miss for the end of its three rungs, prefers a
  rung that passes the plain window (Hydrogen Fuel Rod: its second rung; it needed the doubled window before), and has three more
  rungs with the exact router when the first three fail (Conveyor Belt MK.II fails all three).

### Multi-lane taps (taps.ts)

Span 2 and 3 lanes on one face of a machine existed (a tap whose span-1 point lies on another net's ground takes the next lane out, on a
slot facing the same way). New: when that leaves a tap on a farther lane, or fails, the taps are assigned again with the most demanding
first, and the assignment with fewer sorters wins. Over the 102 ladder layouts and the Quantum Chip it changed 7615 sorters to 7611 and
276 span-2 sorters to 272, and it rescued 1 of 55 annealed placements that had failed to get taps. Sorters of span 2 that reach over
another net's belt: 248 in 33 layouts before, 242 after (the Quantum Chip 26 of 26, Planetary Logistics Station 29 of 34); no span 3
anywhere; none of the 35.5k elevated belt nodes (32.9k before the weighted heuristic) is above a building.

## Rows

Appended by `npm run bench`; a new run goes at the end.

| Date | Commit | Label | Plan | Machines / nets | Budget (s) | First valid (s) | First from | First rate | First footprint | Best footprint | Validated / attempts | Stopped by | Wall (s) |
| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |
| 2026-10-11 | 723fb7c | before Task 27 (BASE) | processor | 19 / 9 | 60 | 0.1 | ladder: margin 3 | 1.000 | 3419 | 694 | 32 / 86 | budget | 60.0 |
| 2026-10-11 | 723fb7c | before Task 27 (BASE) | quantum-chip | 231 / 56 | 60 | 7.8 | ladder: margin 3 | 1.003 | 45360 | 22378 | 3 / 6 | budget | 60.0 |
| 2026-10-11 | 723fb7c | before Task 27 (BASE) | circuit-board | 3 / 5 | 60 | 0.0 | ladder: margin 3 | 1.500 | 529 | 142 | 492 / 991 | budget | 60.0 |
| 2026-10-11 | 723fb7c | before Task 27 (BASE) | smelter-row | 12 / 2 | 60 | 0.0 | ladder: margin 3 | 1.000 | 1477 | 465 | 95 / 200 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27 (BASE) | pls | 457 / 94 | 1 | 111.0 | ladder: margin 6 | 0.990 | 139490 | 139490 | 3 / 3 | budget | 111.0 |
| 2026-10-12 | 95b6851 | after Task 27 | processor | 19 / 9 | 60 | 0.1 | ladder: margin 3 | 1.000 | 3419 | 707 | 80 / 121 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27 | quantum-chip | 231 / 56 | 60 | 3.2 | ladder: margin 3 | 1.000 | 45011 | 23758 | 3 / 8 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27 | circuit-board | 3 / 5 | 60 | 0.0 | ladder: margin 3 | 1.500 | 529 | 141 | 731 / 875 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27 | smelter-row | 12 / 2 | 60 | 0.0 | ladder: margin 3 | 1.000 | 1477 | 524 | 98 / 181 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27 | pls | 457 / 94 | 1 | 56.4 | ladder: margin 6 | 0.990 | 138368 | 138368 | 3 / 3 | budget | 56.4 |
| 2026-10-12 | 723fb7c | before Task 27, seed 1, paired | processor | 19 / 9 | 60 | 0.1 | ladder: margin 3 | 1.000 | 3419 | 737 | 30 / 81 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 1, paired | quantum-chip | 231 / 56 | 60 | 8.3 | ladder: margin 3 | 1.003 | 45360 | 25620 | 2 / 5 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 1, paired | circuit-board | 3 / 5 | 60 | 0.0 | ladder: margin 3 | 1.500 | 529 | 142 | 475 / 963 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 1, paired | smelter-row | 12 / 2 | 60 | 0.0 | ladder: margin 3 | 1.000 | 1477 | 465 | 92 / 191 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 1, paired | processor | 19 / 9 | 60 | 0.1 | ladder: margin 3 | 1.000 | 3419 | 707 | 78 / 118 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 1, paired | quantum-chip | 231 / 56 | 60 | 3.2 | ladder: margin 3 | 1.000 | 45011 | 21870 | 3 / 8 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 1, paired | circuit-board | 3 / 5 | 60 | 0.0 | ladder: margin 3 | 1.500 | 529 | 141 | 703 / 841 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 1, paired | smelter-row | 12 / 2 | 60 | 0.0 | ladder: margin 3 | 1.000 | 1477 | 524 | 97 / 175 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 2, paired | processor | 19 / 9 | 60 | 0.1 | ladder: margin 3 | 1.000 | 3419 | 664 | 44 / 91 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 2, paired | quantum-chip | 231 / 56 | 60 | 8.1 | ladder: margin 3 | 1.003 | 45360 | 25575 | 2 / 3 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 2, paired | circuit-board | 3 / 5 | 60 | 0.0 | ladder: margin 3 | 1.500 | 529 | 151 | 457 / 807 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 2, paired | smelter-row | 12 / 2 | 60 | 0.0 | ladder: margin 3 | 1.000 | 1477 | 460 | 80 / 184 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 2, paired | processor | 19 / 9 | 60 | 0.1 | ladder: margin 3 | 1.000 | 3419 | 741 | 69 / 105 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 2, paired | quantum-chip | 231 / 56 | 60 | 3.3 | ladder: margin 3 | 1.000 | 45011 | 24915 | 2 / 5 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 2, paired | circuit-board | 3 / 5 | 60 | 0.0 | ladder: margin 3 | 1.500 | 529 | 161 | 604 / 901 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 2, paired | smelter-row | 12 / 2 | 60 | 0.0 | ladder: margin 3 | 1.000 | 1477 | 441 | 102 / 173 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 3, paired | processor | 19 / 9 | 60 | 0.1 | ladder: margin 3 | 1.000 | 3419 | 628 | 55 / 112 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 3, paired | quantum-chip | 231 / 56 | 60 | 8.2 | ladder: margin 3 | 1.003 | 45360 | 23598 | 2 / 3 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 3, paired | circuit-board | 3 / 5 | 60 | 0.0 | ladder: margin 3 | 1.500 | 529 | 179 | 186 / 442 | budget | 60.0 |
| 2026-10-12 | 723fb7c | before Task 27, seed 3, paired | smelter-row | 12 / 2 | 60 | 0.0 | ladder: margin 3 | 1.000 | 1477 | 420 | 91 / 185 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 3, paired | processor | 19 / 9 | 60 | 0.1 | ladder: margin 3 | 1.000 | 3419 | 630 | 68 / 103 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 3, paired | quantum-chip | 231 / 56 | 60 | 3.2 | ladder: margin 3 | 1.000 | 45011 | 24613 | 2 / 8 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 3, paired | circuit-board | 3 / 5 | 60 | 0.0 | ladder: margin 3 | 1.500 | 529 | 174 | 669 / 899 | budget | 60.0 |
| 2026-10-12 | 95b6851 | after Task 27, seed 3, paired | smelter-row | 12 / 2 | 60 | 0.0 | ladder: margin 3 | 1.000 | 1477 | 400 | 112 / 169 | budget | 60.0 |
