// The messages between the solver worker and its client (Task 24), and the plain-data forms of what they carry.
// The plan and the tech effects hold Sets, which travel as arrays; the data index and the clock do not travel at all
// (the worker indexes the GameData itself and uses its own clock).
import type { PlanRequest, ProductionPlan } from '../calc';
import type { GameData, TechEffects } from '../data';
import type { Layout } from '../geometry';
import type { ValidationReport } from '../validate';
import type { SolveOptions, SolveProgress, SolveResult } from './solver';

export type WireSolveOptions = Omit<SolveOptions, 'now'>;

export type SerializedPlan = Omit<ProductionPlan, 'request'> & {
  request: Omit<PlanRequest, 'unlockedTechs' | 'suppliedItemIds'> & { unlockedTechs: number[]; suppliedItemIds: number[] };
};

export type SerializedEffects = Omit<TechEffects, 'unlockedRecipes' | 'availableBuildings'> & {
  unlockedRecipes: number[];
  availableBuildings: number[];
};

export type ClientMessage =
  | { type: 'start'; plan: SerializedPlan; data: GameData; effectsSerialized: SerializedEffects; opts: WireSolveOptions }
  | { type: 'stop' };

export type WorkerMessage =
  | { type: 'progress'; progress: SolveProgress }
  | { type: 'improved'; layout: Layout; report: ValidationReport; footprint: number }
  | { type: 'done'; result: SolveResult }
  | { type: 'error'; message: string };

export function serializePlan(plan: ProductionPlan): SerializedPlan {
  const { unlockedTechs, suppliedItemIds, ...request } = plan.request;
  return { ...plan, request: { ...request, unlockedTechs: [...unlockedTechs], suppliedItemIds: [...suppliedItemIds] } };
}

export function deserializePlan(plan: SerializedPlan): ProductionPlan {
  const { unlockedTechs, suppliedItemIds, ...request } = plan.request;
  return { ...plan, request: { ...request, unlockedTechs: new Set(unlockedTechs), suppliedItemIds: new Set(suppliedItemIds) } };
}

export function serializeEffects(effects: TechEffects): SerializedEffects {
  return { ...effects, unlockedRecipes: [...effects.unlockedRecipes], availableBuildings: [...effects.availableBuildings] };
}

export function deserializeEffects(effects: SerializedEffects): TechEffects {
  return { ...effects, unlockedRecipes: new Set(effects.unlockedRecipes), availableBuildings: new Set(effects.availableBuildings) };
}
