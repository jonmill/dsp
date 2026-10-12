# In-game regression fixtures

Each `*.json` file in this folder is one blueprint that was built in the game together with the item rates measured
there. `app/test/regression.test.ts` imports every one, simulates it with the tick simulator and requires each measured
rate to be matched within **2 %** (relative; spec §11). With no fixtures here the suite passes and logs
"no regression fixtures yet". Run it with `npm test` (in `app/`), or alone with
`npx vitest run test/regression.test.ts`.

## Fixture format

```json
{
  "blueprint": "BLUEPRINT:0,10,...",
  "gameVersion": "0.10.33.27026",
  "targetItemId": 1101,
  "measuredRates": { "1101": 2.97 },
  "notes": "3 Arc Smelters, Iron Ingot, sandbox save, equator, all techs. Station stock over 5 min."
}
```

| Field | Meaning |
|---|---|
| `blueprint` | The blueprint string (`BLUEPRINT:...`). Both a string the planner generated and one the game exported are fine. |
| `gameVersion` | The game version the rates were measured on. Informational: when it differs from the loaded GameData, the test logs both. |
| `targetItemId` | The item the block delivers to its station: the one counted at the station's input port. |
| `measuredRates` | Items per second measured in game, by item id (a JSON string key). One entry per item you measured, the target included. |
| `notes` | Free text: what the block is and how it was measured. It is shown when the fixture fails. |
| `unlockedTechs` | Optional. Tech ids researched when you measured. Default: all published techs. Sorter stacking and station piling follow from the techs, so set this if the save did not have them all. |

The test counts an item where it **arrives at a station input port** (the station's input count). So every item in
`measuredRates` must have a storage slot on a station in the blueprint, and the blueprint must contain the station: a
rate for an item no station stocks fails, with a message that says why.

## How the simulator is run

- `blueprintToLayout` (`app/src/lib/blueprint/import.ts`) turns the blueprint into a `Layout`. Records the planner does
  not model (splitters, depots, spray coaters, unknown items) are skipped and listed as warnings in the test log; a belt
  that ran into one is left open. Check that the log shows no warning that changes the block you measured.
- `regressionPlanFor` builds the plan from the layout: one stage per recipe, with the machines it finds. The target is
  `targetItemId`. **No rate is provisioned**, so nothing is judged against a plan: the simulator warms up for its full
  20 game minutes (the block is in a steady state, as it was when you measured) and then counts 5 game minutes.
- The simulator counts items over its 300 s window, so its rate moves in steps of `1/300` items/s (more with stacked
  cargo); a measured rate below about 0.3/s cannot reliably be matched to 2 %. Measure a block that delivers at least
  1 item/s.

## Recording a measurement in game

1. **Build the block from the planner's blueprint** in a sandbox save on the equator band (the grid assumptions hold
   there), with power connected and every sorter working. Let it run until it is in a steady state: all machines busy, belts
   full. Give it at least 10 minutes of game time after the first items arrive.
2. **Make the station count what arrives.** Open the station that receives the target item. The item's slot should be a
   supply slot (the planner sets this up) with room to spare (its max is not reached during the measurement) and nothing
   should take the item out of the station while you measure: no drones or vessels that demand it, and no output port
   configured for it.
3. **Read the count twice, at least 60 seconds of game time apart** (more is better: 5 minutes averages out the
   items-per-cargo steps). Use the game's own clock, not wall time, and do not change the game speed in between. Write
   down the station's stock of the item at both times.
4. **Rate = (second count − first count) / seconds between the readings.** Repeat for the other items you care about
   (other products delivered to a station) and average a few readings.
5. **Export the block back from the game** (select it, then copy the blueprint to the clipboard) if you changed anything
   by hand after pasting, so the fixture describes what you measured. A blueprint straight from the planner is fine when
   you pasted it unchanged.
6. **Write the fixture**: save the JSON above as `app/test/fixtures/regression/<short-name>.json` with a name that says what
   the block is (`iron-ingot-3-per-s.json`). Put the game version (shown at the bottom of the main menu), the save's tech
   state and anything unusual into `notes`.
7. Run `npm test`. If a rate is off by more than 2 %, the failure message gives both rates. The difference is a finding
   about the simulator (or the importer), not a reason to edit the measurement.

Keep one fixture per distinct block and per distinct behaviour you want pinned down (a belt tier, sorter tiers and
spans, a long chain, a station fed by several belts). Do not commit game files or screenshots here, only the JSON.
