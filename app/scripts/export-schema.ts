// Writes data/schema/gamedata.schema.json from the zod GameData schema. The Python extractor
// validates its output against that file (jsonschema, Draft 2020-12), so the zod schema stays
// the single source of truth. Run with `npm run schema` and commit the result.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameDataJsonSchema } from '../src/lib/data/schema';

const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/schema/gamedata.schema.json',
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(gameDataJsonSchema(), null, 2)}\n`);
console.log(`wrote ${outPath}`);
