// The simulated world: belts built from a Layout, the station boxes behind its ports, a fixed tick order and the
// registration points for the sorters, machines and spray coaters that later tasks add.
//
// Belt cells. A belt of `n` nodes is `n · beltCellsPerTile` cells (MX §2.2). Each end of a belt that meets a
// station port adds `2 · beltCellsPerTile / 2` cells, approximating the two half-tile stub records the blueprint
// has there (blueprint/build.ts). Cell 0 is the head. Node `i` is the middle of its tile: cell
// `stubCells + i · beltCellsPerTile + beltCellsPerTile / 2`, where `stubCells` is the head stub. Sorters attach there.
//
// Tick order (MX §10.7, WV order): power ratio from last tick's demand, machines, station input ports, sorters,
// belts, spray coaters, station output ports. Entities registered for a phase run in registration order, after
// the world's own work for that phase (station input, belt update, station output).
import type { ProductionPlan } from '../../calc';
import type { GameDataIndex, TechEffects } from '../../data';
import type { Layout } from '../../geometry';
import { BeltSim } from './belt';
import { CARGO_LENGTH } from './cargo';
import { StationSim } from './station';

/** The steps of one tick, in the order they run. `coaters` is the spray-coater step of MX §10.7. */
export type Phase = 'power' | 'machines' | 'stationIn' | 'sorters' | 'belts' | 'coaters' | 'stationOut';

const PHASES: readonly Phase[] = ['power', 'machines', 'stationIn', 'sorters', 'belts', 'coaters', 'stationOut'];

/** Anything that acts once per tick. */
export interface SimEntity {
  tick(): void;
}

export interface WorldOptions {
  /** Power the block's network can supply, in watts. Omitted: unlimited, `powerRatio` is always 1. */
  powerSupplyW?: number;
}

interface BeltEntry {
  sim: BeltSim;
  nodeCount: number;
  /** Cells before node 0's tile: a port stub at the head end, or none. */
  stubCells: number;
}

export class World {
  readonly layout: Layout;
  readonly plan: ProductionPlan;
  readonly data: GameDataIndex;
  readonly effects: TechEffects;
  /** Every belt's simulation by `BeltPath.id`, in layout order. */
  readonly belts: ReadonlyMap<number, BeltSim>;
  /** Every station's simulation by building id, in layout order. */
  readonly stations: ReadonlyMap<number, StationSim>;

  private readonly beltEntries = new Map<number, BeltEntry>();
  private readonly beltList: BeltSim[] = [];
  private readonly stationList: StationSim[];
  private readonly cellsPerTile: number;
  private readonly phases: Record<Phase, SimEntity[]> = {
    power: [],
    machines: [],
    stationIn: [],
    sorters: [],
    belts: [],
    coaters: [],
    stationOut: [],
  };
  private readonly supplyPerTick: number | undefined;
  private ratio = 1;
  private demand = 0;
  private lastDemand = 0;
  private tickCount = 0;

  constructor(layout: Layout, plan: ProductionPlan, data: GameDataIndex, effects: TechEffects, opts: WorldOptions = {}) {
    this.layout = layout;
    this.plan = plan;
    this.data = data;
    this.effects = effects;
    const constants = data.data.constants;
    if (constants.cargoLength !== CARGO_LENGTH) {
      throw new Error(`the simulator models cargo of ${CARGO_LENGTH} cells, GameData says ${constants.cargoLength}`);
    }
    this.cellsPerTile = constants.beltCellsPerTile;
    this.supplyPerTick = opts.powerSupplyW === undefined ? undefined : opts.powerSupplyW / constants.ticksPerSecond;

    const stations = new Map<number, StationSim>();
    for (const b of layout.buildings) {
      if (b.station) stations.set(b.id, new StationSim(b.station, effects.stationPilerLevel));
    }
    this.stations = stations;
    this.stationList = [...stations.values()];

    for (const belt of layout.belts) {
      const speed = data.building(belt.tierItemId)?.belt?.speed;
      if (speed === undefined) throw new Error(`belt ${belt.id}: item ${belt.tierItemId} is not a belt tier`);
      const stub = Math.round(this.cellsPerTile);
      const stubCells = belt.source ? stub : 0;
      const tailStub = belt.sink?.kind === 'port' ? stub : 0;
      const length = Math.round(belt.nodes.length * this.cellsPerTile) + stubCells + tailStub;
      const sim = new BeltSim(length, speed);
      this.beltEntries.set(belt.id, { sim, nodeCount: belt.nodes.length, stubCells });
      this.beltList.push(sim);
    }
    this.belts = new Map([...this.beltEntries].map(([id, entry]) => [id, entry.sim]));

    for (const belt of layout.belts) {
      const sim = this.belt(belt.id);
      if (belt.source) {
        this.stationOf(belt.id, 'source', belt.source.buildingId).attachOutput(belt.source.port, sim);
      }
      const sink = belt.sink;
      if (sink?.kind === 'port') {
        this.stationOf(belt.id, 'sink', sink.buildingId).attachInput(sink.port, sim);
      } else if (sink?.kind === 'belt') {
        if (!this.beltEntries.has(sink.beltId)) throw new Error(`belt ${belt.id} sink: no belt ${sink.beltId}`);
        sim.setOutput(this.belt(sink.beltId), this.cellOfNode(sink.beltId, sink.node));
      }
    }
  }

  /** Ticks run so far. */
  get ticks(): number {
    return this.tickCount;
  }

  /** Share of their demand that consumers get this tick: 1 unless `powerSupplyW` caps it. */
  get powerRatio(): number {
    return this.ratio;
  }

  /** Register `entity` to run in `phase` every tick. */
  addEntity(entity: SimEntity, phase: Phase): void {
    const list = this.phases[phase];
    if (!list) throw new Error(`unknown phase '${phase}' (expected one of ${PHASES.join(', ')})`);
    list.push(entity);
  }

  /**
   * Report power an entity wants this tick, in J/tick (W / 60). The sum of one tick's reports sets the next
   * tick's `powerRatio`.
   */
  addPowerDemand(joulesPerTick: number): void {
    this.demand += joulesPerTick;
  }

  /** The simulation of belt `beltId`. Throws if the layout has no such belt. */
  belt(beltId: number): BeltSim {
    const entry = this.beltEntries.get(beltId);
    if (!entry) throw new Error(`no belt ${beltId} in the layout`);
    return entry.sim;
  }

  /** The simulation of the station on building `buildingId`. Throws if that building has no station. */
  station(buildingId: number): StationSim {
    const station = this.stations.get(buildingId);
    if (!station) throw new Error(`building ${buildingId} has no station`);
    return station;
  }

  /** The cell of belt `beltId` that node `node` maps to: the middle of that node's tile. */
  cellOfNode(beltId: number, node: number): number {
    const entry = this.beltEntries.get(beltId);
    if (!entry) throw new Error(`no belt ${beltId} in the layout`);
    if (!Number.isInteger(node) || node < 0 || node >= entry.nodeCount) {
      throw new RangeError(`belt ${beltId} has no node ${node} (0..${entry.nodeCount - 1})`);
    }
    return Math.round(entry.stubCells + node * this.cellsPerTile + this.cellsPerTile / 2);
  }

  /** The belt simulation and cell for node `node` of belt `beltId`: where a sorter at that node picks or drops. */
  beltCell(beltId: number, node: number): { belt: BeltSim; cell: number } {
    return { belt: this.belt(beltId), cell: this.cellOfNode(beltId, node) };
  }

  /** Run one tick, in the order of MX §10.7. */
  tick(): void {
    this.updatePower();
    this.runPhase('power');
    this.runPhase('machines');
    for (const station of this.stationList) station.tickInput(this.tickCount);
    this.runPhase('stationIn');
    this.runPhase('sorters');
    for (const belt of this.beltList) belt.update();
    this.runPhase('belts');
    this.runPhase('coaters');
    for (const station of this.stationList) station.tickOutput(this.tickCount);
    this.runPhase('stationOut');
    this.tickCount++;
  }

  // mirrors: PowerSystem.GameTick
  /**
   * The consumer ratio: with a supply cap, `min(1, supply / demand)` from the demand reported during the last tick
   * (MX §6.2: the network is balanced first, from last tick's demand). No cap, or no demand, gives 1.
   */
  private updatePower(): void {
    this.lastDemand = this.demand;
    this.demand = 0;
    const supply = this.supplyPerTick;
    this.ratio = supply === undefined || this.lastDemand <= supply ? 1 : supply / this.lastDemand;
  }

  private runPhase(phase: Phase): void {
    const entities = this.phases[phase];
    for (let i = 0; i < entities.length; i++) entities[i].tick();
  }

  private stationOf(beltId: number, end: 'source' | 'sink', buildingId: number): StationSim {
    const station = this.stations.get(buildingId);
    if (!station) throw new Error(`belt ${beltId} ${end}: building ${buildingId} is not a station in the layout`);
    return station;
  }
}
