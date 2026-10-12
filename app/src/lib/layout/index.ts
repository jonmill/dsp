export { startSolve, STOP_GRACE_MS } from './client';
export type { SolveCallbacks, SolveHandle, WorkerLike } from './client';
export type { WireSolveOptions } from './protocol';
export { applyMotifs, enabledMotifKinds, MOTIFS, proposeMotifs, VERIFIED_MOTIFS } from './motifs';
export type { Motif, MotifInstance, MotifKind } from './motifs';
export { DEFAULT_SOLVE_OPTIONS, footprintOf, solve, solveSteps } from './solver';
export type { SolveOptions, SolveProgress, SolveResult } from './solver';
