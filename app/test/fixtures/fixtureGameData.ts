import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGameData } from '../../src/lib/data';
import type { GameData } from '../../src/lib/data';

const fixturePath = fileURLToPath(new URL('../../../data/fixture/dsp-fixture.json', import.meta.url));

/** The committed fixture GameData (approximate geometry), parsed fresh. */
export function loadFixtureGameData(): GameData {
  return parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown, 'dsp-fixture.json');
}
