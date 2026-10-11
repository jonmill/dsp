import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeBlueprint } from '../../src/lib/blueprint/codec';
import type { Blueprint, BlueprintBuilding } from '../../src/lib/blueprint/model';

/** A real game export from `test/fixtures/blueprints/`, decoded. */
export function loadBlueprintSample(file: string): Blueprint {
  const path = fileURLToPath(new URL(`./blueprints/${file}`, import.meta.url));
  return decodeBlueprint(readFileSync(path, 'utf8'));
}

/** Belt Mk.III or Mk.II chain records etc. are told apart by item id; sorters are the 2011..2014 range. */
export const isSorter = (r: BlueprintBuilding): boolean => r.itemId > 2010 && r.itemId < 2020;

/** One sorter between a belt and an assembler in a real export, with both ends in blueprint coordinates. */
export interface AssemblerSorter {
  sorter: BlueprintBuilding;
  assembler: BlueprintBuilding;
  /** 'input' picks from a belt and drops into the assembler; 'output' the other way round. */
  kind: 'input' | 'output';
  /** The assembler's sorter slot index. */
  slot: number;
  span: number;
}

/** Every sorter of `bp` that joins a belt and a building with item id `assemblerItemId`. */
export function assemblerSorters(bp: Blueprint, assemblerItemId: number): AssemblerSorter[] {
  const recs = bp.body.buildings;
  const out: AssemblerSorter[] = [];
  for (const s of recs.filter(isSorter)) {
    const pick = recs[s.inputObjIdx];
    const drop = recs[s.outputObjIdx];
    if (!pick || !drop) continue;
    const isBelt = (r: BlueprintBuilding) => r.itemId > 2000 && r.itemId < 2010;
    if (drop.itemId === assemblerItemId && isBelt(pick)) {
      out.push({ sorter: s, assembler: drop, kind: 'input', slot: s.outputToSlot, span: s.parameters[0] });
    } else if (pick.itemId === assemblerItemId && isBelt(drop)) {
      out.push({ sorter: s, assembler: pick, kind: 'output', slot: s.inputFromSlot, span: s.parameters[0] });
    }
  }
  return out;
}
