/**
 * Thin wrapper over glpk.js: a model of `min cost·v` subject to linear rows over variables `v ≥ 0`.
 * glpk.js ships two builds. The default export runs GLPK in a web worker (browser); `glpk.js/node`
 * is synchronous. Vitest and scripts run in Node, where `Worker` does not exist, so the build is
 * picked at runtime and the instance is created once and cached.
 */
import type { GLPK as GlpkBrowser, LP } from 'glpk.js';
import type { GLPK as GlpkNode } from 'glpk.js/node';

export interface LPVariable {
  name: string;
  /** Objective coefficient (minimised). */
  cost: number;
}

export interface LPConstraint {
  name: string;
  terms: { variable: string; coef: number }[];
  type: 'eq' | 'le' | 'ge';
  rhs: number;
}

export interface LPModel {
  /** All variables are bounded below by 0 and unbounded above. */
  variables: LPVariable[];
  constraints: LPConstraint[];
}

export type LPStatus = 'optimal' | 'infeasible' | 'unbounded' | 'undefined';

export interface LPSolution {
  status: LPStatus;
  /** Variable values; only meaningful when `status` is `'optimal'`. */
  values: Record<string, number>;
  objective: number;
}

type Glpk = GlpkNode | GlpkBrowser;

let glpkPromise: Promise<Glpk> | undefined;

async function createGlpk(): Promise<Glpk> {
  const inNode = typeof globalThis.process?.versions?.node === 'string';
  const factory = inNode ? (await import('glpk.js/node')).default : (await import('glpk.js')).default;
  return factory();
}

/** One shared GLPK instance; a failed initialisation is not cached, so the next call retries. */
function loadGlpk(): Promise<Glpk> {
  glpkPromise ??= createGlpk().catch((error: unknown) => {
    glpkPromise = undefined;
    throw error;
  });
  return glpkPromise;
}

function statusOf(glpk: Glpk, status: number): LPStatus {
  switch (status) {
    case glpk.GLP_OPT:
      return 'optimal';
    case glpk.GLP_INFEAS:
    case glpk.GLP_NOFEAS:
      return 'infeasible';
    case glpk.GLP_UNBND:
      return 'unbounded';
    default:
      return 'undefined';
  }
}

export async function solveLP(model: LPModel): Promise<LPSolution> {
  const glpk = await loadGlpk();
  const bound = (type: LPConstraint['type'], rhs: number) => {
    if (type === 'eq') return { type: glpk.GLP_FX, lb: rhs, ub: rhs };
    if (type === 'le') return { type: glpk.GLP_UP, lb: 0, ub: rhs };
    return { type: glpk.GLP_LO, lb: rhs, ub: 0 };
  };
  const lp: LP = {
    name: 'plan',
    objective: {
      direction: glpk.GLP_MIN,
      name: 'cost',
      vars: model.variables.map((v) => ({ name: v.name, coef: v.cost })),
    },
    subjectTo: model.constraints.map((c) => ({
      name: c.name,
      vars: c.terms.map((t) => ({ name: t.variable, coef: t.coef })),
      bnds: bound(c.type, c.rhs),
    })),
    // Variables are non-negative by default in glpk.js (lower bound 0, no upper bound).
  };
  // The presolver reports infeasible and unbounded models as GLP_UNDEF; without it the statuses are exact.
  const result = await glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF, presol: false });
  return {
    status: statusOf(glpk, result.result.status),
    values: result.result.vars,
    objective: result.result.z,
  };
}
