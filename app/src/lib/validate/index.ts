export { checkCapacity } from './capacity';
export { checkGeometry } from './geometry-checks';
export { checkSimulation, outputTolerance, validateLayout } from './report';
export type { ValidateOptions, ValidationReport } from './report';
export { MAX_WARMUP_TICKS, runSimulation, SimulationAborted, WarmupNotSettled } from './sim/run';
export type { MachineStat, SimOptions, SimResult, StageStat } from './sim/run';
export type { Violation, ViolationCode, ViolationEntity } from './types';
