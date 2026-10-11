"""Default `GameData.constants` and where each value comes from.

These are the values the research notes give. Every default is tagged `(unverified)` in its source
string until a real extraction reads the value from game code and overrides both the value and the
source (Task 6). The keys mirror `ConstantsSchema` in app/src/lib/data/schema.ts exactly.
"""

from __future__ import annotations

TILE_METERS = 1.2566370614359172  # 2*pi*200/1000, the grid tile at the equator
LEVEL_METERS = 4 / 3

DEFAULT_CONSTANTS: dict[str, object] = {
    "ticksPerSecond": 60,
    "cargoLength": 10,
    "beltCellsPerTile": 20,
    "tileMeters": TILE_METERS,
    "levelMeters": LEVEL_METERS,
    "sorterMaxReachMeters": 5.5,
    "sorterMaxGridSpan": 3.499,
    "beltMaxLevelBase": 12,
    "beltMaxLevelPerVerticalTech": 6,
    "incTableMilli": [0, 125, 200, 225, 250, 275, 300, 325, 350, 375, 400],
    "accTableMilli": [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500],
    "powerTableRatio": [0, 300, 700, 1100, 1500, 1900, 2300, 2700, 3100, 3500, 3900],
    "assemblerOutputCrafts": {"SMELT_items": 100, "ASSEMBLE_crafts": 10, "OTHER_crafts": 20},
    "stationDefaultChargePerTick": {"planetary": 200000, "interstellar": 1000000},
}

DEFAULT_CONSTANT_SOURCES: dict[str, str] = {
    "ticksPerSecond": "research:mechanics.md§0 (unverified)",
    "cargoLength": "research:mechanics.md§2.2 CargoPath.kCargoLength (unverified)",
    "beltCellsPerTile": "research:mechanics.md§2.2 (unverified, approximate)",
    "tileMeters": "research:blueprint-format.md§5 (2*pi*200/1000, unverified)",
    "levelMeters": "research:blueprint-format.md§5 HEIGHT_GRID_SIZE (unverified)",
    "sorterMaxReachMeters": "research:mechanics.md§3.5 (unverified)",
    "sorterMaxGridSpan": "research:mechanics.md§3.5 (unverified)",
    "beltMaxLevelBase": "research:mechanics.md§2.4 (unverified)",
    "beltMaxLevelPerVerticalTech": "research:mechanics.md§2.4 (unverified)",
    "incTableMilli": "research:mechanics.md§5 (unverified)",
    "accTableMilli": "research:mechanics.md§5 (unverified)",
    "powerTableRatio": "research:mechanics.md§5 (unverified)",
    "assemblerOutputCrafts": "research:mechanics.md§4.3 (unverified)",
    "stationDefaultChargePerTick": "research:mechanics.md§6.3 (unverified)",
}
