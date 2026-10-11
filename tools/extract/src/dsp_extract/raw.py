"""The raw bundle: the in-memory shape both the game reader and the fixture builder produce.

Proto dicts keep whatever spelling their source used (PascalCase from the game, camelCase from the
dsp-parser dump); `normalize.normalize` accepts both. The helpers at the bottom are the shared
value cleanup: key-case folding and BigInt decoding.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RawBuilding:
    """One building prefab. `None` for colliders/slot_poses/port_poses means "not extracted"."""

    item_id: int
    model_index: int
    # Component class name -> fields, e.g. "AssemblerDesc", "PowerDesc", "SlotConfig",
    # "BuildConditionConfig", "InserterDesc", "BeltDesc", "StationDesc", "SpraycoaterDesc", "LabDesc".
    descs: dict[str, dict]
    # [{"center": [...], "halfExtents": [...], "rotation": [x, y, z, w], "usage": "build" | ...}]
    colliders: list[dict] | None = None
    # Sorter slots (PrefabDesc.slotPoses): [{"position": [...], "rotation": [...]}]
    slot_poses: list[dict] | None = None
    # Belt ports (PrefabDesc.portPoses), same pose shape.
    port_poses: list[dict] | None = None


@dataclass
class RawBundle:
    game_version: str
    steam_build_id: str | None
    source: str  # "game" | "fixture"
    items: list[dict]
    recipes: list[dict]
    techs: list[dict]
    buildings: list[RawBuilding]
    locale: dict[str, str]  # key -> English
    constants: dict[str, object] = field(default_factory=dict)
    constant_sources: dict[str, str] = field(default_factory=dict)
    proto_signatures: dict[str, str] = field(default_factory=dict)


def norm_key(key: str) -> str:
    """`TimeSpend` -> `timeSpend`, `ID` -> `id`; already-camelCase and `_private` keys are unchanged."""
    if key.isupper():
        return key.lower()
    return key[:1].lower() + key[1:]


def is_bigint(value: object) -> bool:
    return isinstance(value, dict) and value.get(":type") == "BigInt"


def clean(value: object) -> object:
    """Recursively fold dict keys with `norm_key` and decode `{":type":"BigInt","value":"…"}` to int."""
    if is_bigint(value):
        assert isinstance(value, dict)
        return int(value["value"])
    if isinstance(value, dict):
        return {norm_key(str(k)): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return value


def vec(value: object, n: int) -> list:
    """`n` numbers from a list/tuple or an `{x, y, z, w}` dict (the shape UnityPy yields for vectors)."""
    if isinstance(value, dict):
        value = [value.get(k, 0) for k in "xyzw"[:n]]
    if not isinstance(value, (list, tuple)) or len(value) != n:
        raise ValueError(f"expected {n} numbers, got {value!r}")
    return list(value)
