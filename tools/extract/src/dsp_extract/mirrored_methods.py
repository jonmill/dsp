"""Game methods that the TypeScript code mirrors, and the TS module that mirrors each.

`decompile.build_fingerprints` hashes these methods from the decompiled `Assembly-CSharp.dll`, and
`decompile.drift_report` names the TS modules to re-check when one of the hashes changes after a game
patch. Every `// mirrors: Type.Method` comment in `app/src` must have its `Type.Method` here (the
consistency test in Task 30 checks that), and the type must be listed in `decompile.TYPES_TO_DECOMPILE`.
Paths are relative to the repository root.
"""

from __future__ import annotations

MIRRORED: dict[str, str] = {
    # Blueprint codec (Task 8)
    "BlueprintData.Export": "app/src/lib/blueprint/codec.ts",
    "BlueprintData.Import": "app/src/lib/blueprint/codec.ts",
    "MD5F.Compute": "app/src/lib/blueprint/md5f.ts",
    # Build-condition checks (Task 15)
    "BuildTool_Click.CheckBuildConditions": "app/src/lib/validate/geometry-checks.ts",
    "BuildTool_Path.CheckBuildConditions": "app/src/lib/validate/geometry-checks.ts",
    # The sorter's length and skew rules (rules 8 and 10) live in geometry/sorter-rules.ts, shared with the layout solver
    # (Task 24b); the validator's other sorter rules (lattice tap, slots, in-building, belt end) that carry the same
    # `// mirrors:` marker are still in validate/geometry-checks.ts, so re-check that file too when this method drifts.
    "BuildTool_Inserter.CheckBuildConditions": "app/src/lib/geometry/sorter-rules.ts",
    # Tick simulator: belts, stations and power (Task 17)
    "CargoPath.Update": "app/src/lib/validate/sim/belt.ts",
    "CargoPath.TryInsertItem": "app/src/lib/validate/sim/belt.ts",
    "CargoPath.TryPickItem": "app/src/lib/validate/sim/belt.ts",
    "CargoPath.TryPickItemAtRear": "app/src/lib/validate/sim/belt.ts",
    "CargoPath.TryInsertItemAtHeadAndFillBlank": "app/src/lib/validate/sim/belt.ts",
    "StationComponent.UpdateOutputSlots": "app/src/lib/validate/sim/station.ts",
    "StationComponent.UpdateInputSlots": "app/src/lib/validate/sim/station.ts",
    "PowerSystem.GameTick": "app/src/lib/validate/sim/world.ts",
    # Tick simulator: sorters (Task 18)
    "InserterComponent.InternalUpdate": "app/src/lib/validate/sim/sorter.ts",
    # Tick simulator: machines and spray coaters (Task 19)
    "AssemblerComponent.InternalUpdate": "app/src/lib/validate/sim/machine.ts",
    "AssemblerComponent.UpdateNeeds": "app/src/lib/validate/sim/machine.ts",
    "LabComponent.InternalUpdateAssemble": "app/src/lib/validate/sim/machine.ts",
    "SpraycoaterComponent.InternalUpdate": "app/src/lib/validate/sim/coater.ts",
}
