// Consistency of the "mirrors" markers with the extractor's list of mirrored game methods (global convention: every ported
// game-logic function has a `// mirrors: Type.Method` comment, and `Type.Method` is a key of `MIRRORED` in
// `tools/extract/src/dsp_extract/mirrored_methods.py`). The extractor hashes exactly the methods in that list, so a marker
// for a method that is missing there would never be noticed when a game patch changes it (`dsp-extract --check`).
//
// Three spellings count as a marker:
//   `// mirrors: Type.Method`                       a comment above the ported function
//   `mirrors: 'Type.Method'`                        a violation's `mirrors` field written out
//   `const MIRROR_X = 'Type.Method'`                the constants the geometry rules pass to `emit(..., mirrors)`
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appSrc = fileURLToPath(new URL('../src/', import.meta.url));
const mirroredMethods = fileURLToPath(new URL('../../tools/extract/src/dsp_extract/mirrored_methods.py', import.meta.url));

const METHOD = String.raw`[A-Za-z_]\w*(?:\.\w+)+`;
const MARKERS = [
  new RegExp(String.raw`//\s*mirrors:\s*(${METHOD})`, 'g'),
  new RegExp(String.raw`\bmirrors\s*:\s*['"](${METHOD})['"]`, 'g'),
  new RegExp(String.raw`\bMIRROR_\w+\s*=\s*['"](${METHOD})['"]`, 'g'),
];

interface Marker {
  method: string;
  file: string;
  line: number;
}

/** Every `.ts` and `.svelte` file under `dir`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|svelte)$/.test(entry.name) ? [path] : [];
  });
}

/** Every mirrors marker under `app/src`, with where it is. */
function markersIn(root: string): Marker[] {
  const found: Marker[] = [];
  for (const path of sourceFiles(root)) {
    const text = readFileSync(path, 'utf8');
    for (const pattern of MARKERS) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        found.push({ method: match[1], file: relative(root, path), line });
      }
    }
  }
  return found;
}

/** The keys of the `MIRRORED` dict in `mirrored_methods.py` (`"Type.Method": "path",`). */
function mirroredKeys(source: string): string[] {
  return [...source.matchAll(/^\s*"([A-Za-z_]\w*(?:\.\w+)+)"\s*:/gm)].map((m) => m[1]);
}

describe('mirrors markers', () => {
  const keys = new Set(mirroredKeys(readFileSync(mirroredMethods, 'utf8')));
  const markers = markersIn(appSrc);

  // Floors that only prove the patterns find something (a regex that rotted finds nothing). They are far below today's counts, so
  // consolidating markers or dropping a mirrored method does not trip them; the second test is the one that judges the markers.
  it('finds the list of mirrored methods and the markers in the source (the patterns have not rotted)', () => {
    expect(keys.size).toBeGreaterThanOrEqual(5);
    expect(markers.length).toBeGreaterThanOrEqual(10);
    expect(new Set(markers.map((m) => m.method)).size).toBeGreaterThanOrEqual(5);
  });

  it('every method named by a `mirrors` marker in app/src is listed in mirrored_methods.py', () => {
    const missing = markers.filter((m) => !keys.has(m.method)).map((m) => `${m.method} (app/src/${m.file}:${m.line})`);
    expect(missing, 'add these to MIRRORED in tools/extract/src/dsp_extract/mirrored_methods.py').toEqual([]);
  });

  it('reads the three spellings of a marker', () => {
    const scan = (text: string): string[] => MARKERS.flatMap((p) => [...text.matchAll(p)].map((m) => m[1]));
    expect(scan('  // mirrors: CargoPath.Update\n')).toEqual(['CargoPath.Update']);
    expect(scan("v.push({ mirrors: 'BuildTool_Path.CheckBuildConditions' })")).toEqual(['BuildTool_Path.CheckBuildConditions']);
    expect(scan("const MIRROR_CLICK = 'BuildTool_Click.CheckBuildConditions';")).toEqual(['BuildTool_Click.CheckBuildConditions']);
    // prose that mentions the marker is not one
    expect(scan('No `// mirrors:` marker here: the rules follow PowerSystem.GameTick')).toEqual([]);
  });
});
