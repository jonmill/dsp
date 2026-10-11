// What the validator reports about a layout. Shared by the geometry rules, the rate check and the tick
// simulator, so every gate speaks the same violation language.

export type ViolationCode =
  | 'BUILDING_OVERLAP'
  | 'BELT_IN_BUILDING'
  | 'BELT_OVERLAP'
  | 'BELT_DISCONNECTED'
  | 'BELT_BAD_RAMP'
  | 'BELT_TOO_HIGH'
  | 'BELT_PORT_MISMATCH'
  | 'SORTER_SPAN'
  | 'SORTER_SLOT_INVALID'
  | 'SORTER_SLOT_REUSED'
  | 'SORTER_SKEW'
  | 'SORTER_IN_BUILDING'
  | 'SORTER_ENDPOINT_BELT_RAMP'
  | 'SORTER_BELT_TANGENT'
  | 'SORTER_TO_STATION'
  | 'POWER_UNCOVERED'
  | 'POWER_DISCONNECTED'
  | 'STATION_SLOTS'
  // Spray coaters (Task 28 implements the rules; the codes exist so the union is stable).
  | 'COATER_PLACEMENT'
  | 'COATER_UNFED'
  | 'RATE_BELT'
  | 'RATE_SORTER'
  | 'RATE_MACHINE_INPUT'
  | 'SIM_OUTPUT_LOW'
  | 'SIM_DEADLOCK'
  | 'SIM_STALLED';

/** One thing a violation is about. `node` is the node index on a belt. */
export interface ViolationEntity {
  kind: 'building' | 'belt' | 'sorter';
  id: number;
  node?: number;
}

export interface Violation {
  code: ViolationCode;
  entities: ViolationEntity[];
  /** Names the entities involved and what is wrong with them. */
  message: string;
  /** The game method the rule mirrors, e.g. "BuildTool_Path.CheckBuildConditions". */
  mirrors?: string;
}
