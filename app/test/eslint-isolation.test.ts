// The validator must stay independent of the layout solver (Global Constraints): an ESLint rule enforces it. These cases run the
// project's own config over code that sits in the validator directories and check which imports it refuses (final review, T1): the
// patterns once missed a bare `../layout` (no file after the directory) and a dynamic `import()`.
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const MESSAGE = /validator must stay independent of the solver/;

describe('the validator isolation lint rule', () => {
  let eslint: ESLint;
  beforeAll(() => {
    eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });
  });

  /** The messages the project's lint config gives `code` as a file at `filePath`. */
  async function lint(code: string, filePath = 'src/lib/validate/example.ts'): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages.map((m) => m.message);
  }

  const REFUSED: [string, string, string?][] = [
    ['a file of the layout directory', "import { buildNetlist } from '../layout/netlist';"],
    ['the layout directory itself (its index)', "import { solve } from '../layout';"],
    ['the layout directory with a trailing slash', "import { solve } from '../layout/';"],
    ['two levels up, the directory itself', "import { solve } from '../../layout';", 'src/lib/validate/sim/example.ts'],
    ['two levels up, a file', "import { solve } from '../../layout/solver';", 'src/lib/validate/sim/example.ts'],
    ['three levels up, the directory itself', "import { solve } from '../../../layout';", 'src/lib/validate/sim/deep/example.ts'],
    ['a path through lib', "import { solve } from '../../lib/layout/solver';", 'src/lib/validate/sim/example.ts'],
    ['the $lib alias', "import { solve } from '$lib/layout';"],
    ['a type import', "import type { Netlist } from '../layout';"],
    ['a re-export', "export { solve } from '../layout';"],
    ['a star re-export', "export * from '../layout/solver';"],
    ['a dynamic import', "const m = await import('../layout');"],
    ['a dynamic import of a file', "const m = await import('../layout/solver');"],
    ['a dynamic import with a template literal', 'const m = await import(`../layout/${name}`);'],
    ['a dynamic import whose path is a variable', 'const m = await import(path);'],
    ['a dynamic import of a module that is allowed, which cannot be told from the rest', "const m = await import('../geometry');"],
    ['a require', "const m = require('../layout');"],
    ['a type written as an import type', "type Solve = import('../layout').solve;"],
    ['an import type of a file', "let x: import('../layout/solver').SolveResult;"],
    ['an import type two levels up', "type Netlist = import('../../layout/netlist').Netlist;", 'src/lib/validate/sim/example.ts'],
  ];

  it.each(REFUSED)('refuses %s', async (_what, code, filePath) => {
    expect(await lint(code, filePath)).toEqual(expect.arrayContaining([expect.stringMatching(MESSAGE)]));
  });

  const ALLOWED: [string, string, string?][] = [
    ['the shared geometry', "import { buildingDef } from '../geometry';"],
    ['the calculator types', "import type { ProductionPlan } from '../calc';"],
    ['its own files', "import { runSimulation } from './sim/run';"],
    ['a module whose name only contains the word', "import { x } from './layoutKit';"],
    ['a package', "import { ESLint } from 'eslint';"],
    ['an import type of the shared geometry', "type Layout = import('../geometry').Layout;"],
  ];

  it.each(ALLOWED)('allows %s', async (_what, code, filePath) => {
    expect(await lint(code, filePath)).not.toEqual(expect.arrayContaining([expect.stringMatching(MESSAGE)]));
  });

  it('leaves the rest of the project free to import the layout solver', async () => {
    expect(await lint("import { solve } from '../layout';", 'src/lib/blueprint/example.ts')).not.toEqual(
      expect.arrayContaining([expect.stringMatching(MESSAGE)]),
    );
    expect(await lint("import { solve } from './layout';", 'src/ui/example.ts')).not.toEqual(
      expect.arrayContaining([expect.stringMatching(MESSAGE)]),
    );
  });
});
