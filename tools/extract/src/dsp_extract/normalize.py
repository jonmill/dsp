"""Turn a `RawBundle` into GameData JSON (plain dicts, shape owned by app/src/lib/data/schema.ts).

One normalizer serves both the game reader (PascalCase protos, raw MonoBehaviour descriptors with
float fields such as `speedf`) and the dsp-parser dump (camelCase, BigInt-encoded int64s, default
values omitted). Every proto key has its first letter lowercased, enums may be strings or ints,
and BigInt values become ints.

Missing fields (Review Focus #1): the dump omits default-valued fields, so only fields listed as
REQUIRED below raise `NormalizeError("<proto> <id> (<nameKey>): missing field <f>")`; every other
field falls back to its default. Nothing is ever written with a guessed value for a required field.
"""

from __future__ import annotations

import copy
import json
import math
from collections.abc import Mapping

from .approx_geometry import approx_geometry, blueprint_box_size, read_config
from .constants import DEFAULT_CONSTANT_SOURCES, DEFAULT_CONSTANTS
from .raw import RawBuilding, RawBundle, clean, vec

SCHEMA_VERSION = 1

# ERecipeType (GX section 2.2) -> the schema's RecipeType spelling.
RECIPE_TYPES = {
    0: "NONE",
    1: "SMELT",
    2: "CHEMICAL",
    3: "REFINE",
    4: "ASSEMBLE",
    5: "PARTICLE",
    6: "EXCHANGE",
    7: "PHOTON_STORE",
    8: "FRACTIONATE",
    15: "RESEARCH",
}
# EItemType (GX section 2.1), spelled as the dump spells it.
ITEM_TYPES = {
    0: "UNKNOWN",
    1: "RESOURCE",
    2: "MATERIAL",
    3: "COMPONENT",
    4: "PRODUCT",
    5: "LOGISTICS",
    6: "PRODUCTION",
    7: "DECORATION",
    8: "TURRET",
    9: "DEFENSE",
    10: "DARKFOG",
    11: "MATRIX",
}

SORTER_CHAIN = (2011, 2012, 2013, 2014)  # grade = position in this chain, from 1
PROLIFERATOR_ITEMS = (1141, 1142, 1143)
SPLITTER_ITEM = 2020
PILER_ITEM = 2040  # the dump omits the empty PilerDesc marker, so the item id stands in for it

SPEED_UNIT = 10000  # assembler/lab speed: 10000 = 1x
STT_UNIT = 600000  # sorter time constants: seconds * 600000
MIN_PRODUCTION_SPEED = 100
MIN_SORTER_STT = 1000
BELT_SPEED_RANGE = (1, 20)
MIN_LAB_RAW_SPEED = 100  # lab speeds below this are float multipliers, not 10000-based ints


class NormalizeError(Exception):
    """Raw game data is missing a required field or holds an implausible value."""


# ---- small coercions --------------------------------------------------------------------------


def _round(value: float) -> int:
    return math.floor(value + 0.5)


def _int(value: object, label: str, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise NormalizeError(f"{label}: field {field} is not a number: {value!r}")
    if isinstance(value, float) and not value.is_integer():
        raise NormalizeError(f"{label}: field {field} is not an integer: {value!r}")
    return int(value)


def _num(value: object, label: str, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise NormalizeError(f"{label}: field {field} is not a number: {value!r}")
    return value


def _bool(value: object, label: str, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    raise NormalizeError(f"{label}: field {field} is not a boolean: {value!r}")


def _list(value: object, label: str, field: str) -> list:
    if not isinstance(value, list):
        raise NormalizeError(f"{label}: field {field} is not a list: {value!r}")
    return value


def _vec(value: object, n: int, label: str, field: str) -> list:
    try:
        out = vec(value, n)
    except ValueError as err:
        raise NormalizeError(f"{label}: field {field}: {err}") from None
    for v in out:
        _num(v, label, field)
    return out


def _require(d: Mapping, field: str, label: str, shown: str | None = None):
    if field not in d:
        raise NormalizeError(f"{label}: missing field {shown or field}")
    return d[field]


def _label(proto: str, d: Mapping) -> str:
    return f"{proto} {d.get('id', '?')} ({d.get('name', '?')})"


def _enum(value: object, table: Mapping[int, str], label: str, field: str) -> str:
    """An enum given as its int value or its name (case and underscores are ignored)."""
    if isinstance(value, int) and not isinstance(value, bool):
        if value not in table:
            raise NormalizeError(f"{label}: unknown {field} value {value!r}")
        return table[value]
    if isinstance(value, str):
        wanted = value.upper().replace("_", "")
        for name in table.values():
            if name.replace("_", "") == wanted:
                return name
    raise NormalizeError(f"{label}: unknown {field} value {value!r}")


def _item_type(value: object, label: str) -> str:
    """Item types are open-ended strings in GameData: ints map through EItemType, names pass through."""
    if isinstance(value, str):
        return value.upper()
    return _enum(value, ITEM_TYPES, label, "type")


def _check_unique(rows: list[dict], key: str, kind: str) -> None:
    seen: set[int] = set()
    for row in rows:
        if row[key] in seen:
            raise NormalizeError(f"duplicate {kind} id {row[key]}")
        seen.add(row[key])


# ---- items, recipes, techs --------------------------------------------------------------------


def _item(raw: dict, locale: Mapping[str, str]) -> dict:
    d = clean(raw)
    label = _label("item", d)
    for field in ("id", "name", "type", "stackSize", "gridIndex"):
        _require(d, field, label)
    item_id = _int(d["id"], label, "id")
    name_key = str(d["name"])
    item = {
        "id": item_id,
        "name": locale.get(name_key, name_key),
        "nameKey": name_key,
        "type": _item_type(d["type"], label),
        "stackSize": _int(d["stackSize"], label, "stackSize"),
        "isFluid": _bool(d.get("isFluid", False), label, "isFluid"),
        "canBuild": _bool(d.get("canBuild", False), label, "canBuild"),
        "productive": _bool(d.get("productive", False), label, "productive"),
        "gridIndex": _int(d["gridIndex"], label, "gridIndex"),
        "iconPath": str(d.get("iconPath", "")),
        "heatValue": _int(d.get("heatValue", 0), label, "heatValue"),
        "modelIndex": _int(d.get("modelIndex", 0), label, "modelIndex"),
    }
    if item_id in PROLIFERATOR_ITEMS:
        # ability = inc points per item; hpMax holds the spray count (12/24/60).
        item["proliferator"] = {
            "ability": _int(_require(d, "ability", label), label, "ability"),
            "sprays": _int(_require(d, "hpMax", label), label, "hpMax"),
        }
    return item


def _item_counts(ids: object, counts: object, label: str, ids_field: str, counts_field: str) -> list[dict]:
    ids = _list(ids, label, ids_field)
    counts = _list(counts, label, counts_field)
    if len(ids) != len(counts):
        raise NormalizeError(f"{label}: {ids_field} has {len(ids)} entries but {counts_field} has {len(counts)}")
    return [
        {"itemId": _int(i, label, ids_field), "count": _int(c, label, counts_field)} for i, c in zip(ids, counts, strict=True)
    ]


def _recipe(raw: dict, locale: Mapping[str, str]) -> dict:
    d = clean(raw)
    label = _label("recipe", d)
    for field in ("id", "name", "type", "timeSpend", "items", "itemCounts", "results", "resultCounts"):
        _require(d, field, label)
    name_key = str(d["name"])
    return {
        "id": _int(d["id"], label, "id"),
        "name": locale.get(name_key, name_key),
        "type": _enum(d["type"], RECIPE_TYPES, label, "type"),
        "timeTicks": _int(d["timeSpend"], label, "timeSpend"),
        "inputs": _item_counts(d["items"], d["itemCounts"], label, "items", "itemCounts"),
        "outputs": _item_counts(d["results"], d["resultCounts"], label, "results", "resultCounts"),
        "explicit": _bool(d.get("explicit", False), label, "explicit"),
        "nonProductive": _bool(d.get("nonProductive", False), label, "nonProductive"),
        "handcraft": _bool(d.get("handcraft", False), label, "handcraft"),
        "gridIndex": _int(d.get("gridIndex", 0), label, "gridIndex"),
    }


def _tech(raw: dict, locale: Mapping[str, str]) -> dict:
    d = clean(raw)
    label = _label("tech", d)
    for field in ("id", "name"):
        _require(d, field, label)
    name_key = str(d["name"])
    functions = _list(d.get("unlockFunctions", []), label, "unlockFunctions")
    values = _list(d.get("unlockValues", []), label, "unlockValues")
    if len(functions) != len(values):
        raise NormalizeError(
            f"{label}: unlockFunctions has {len(functions)} entries but unlockValues has {len(values)}"
        )

    def ids(field: str) -> list[int]:
        return [_int(v, label, field) for v in _list(d.get(field, []), label, field)]

    return {
        "id": _int(d["id"], label, "id"),
        "name": locale.get(name_key, name_key),
        "preTechs": ids("preTechs"),
        "preTechsImplicit": ids("preTechsImplicit"),
        "unlockRecipes": ids("unlockRecipes"),
        "unlockFunctions": [
            {"func": _int(f, label, "unlockFunctions"), "value": _num(v, label, "unlockValues")}
            for f, v in zip(functions, values, strict=True)
        ],
        "level": _int(d.get("level", 0), label, "level"),
        "maxLevel": _int(d.get("maxLevel", 0), label, "maxLevel"),
        "isObsolete": _bool(d.get("isObsolete", False), label, "isObsolete"),
        "isHidden": _bool(d.get("isHiddenTech", False), label, "isHiddenTech"),
        "published": _bool(d.get("published", False), label, "published"),
        "position": _vec(d.get("position", [0, 0]), 2, label, "position"),
    }


# ---- buildings --------------------------------------------------------------------------------


def _scaled(desc: Mapping, whole: str, floaty: str, unit: int, label: str, owner: str) -> int | None:
    """An int field (`whole`) or its float form (`floaty`, times `unit`); None if neither is present."""
    if whole in desc:
        return _round(_num(desc[whole], label, f"{owner}.{whole}"))
    if floaty in desc:
        return _round(_num(desc[floaty], label, f"{owner}.{floaty}") * unit)
    return None


def _production(desc: Mapping, label: str) -> dict:
    speed = _scaled(desc, "speed", "speedf", SPEED_UNIT, label, "AssemblerDesc")
    if speed is None:
        raise NormalizeError(f"{label}: missing field AssemblerDesc.speed")
    if speed < MIN_PRODUCTION_SPEED:
        raise NormalizeError(
            f"{label}: AssemblerDesc.speed {speed} is implausible (10000 = 1x); check the float-to-int conversion"
        )
    return {"recipeType": _enum(desc.get("recipeType", 0), RECIPE_TYPES, label, "AssemblerDesc.recipeType"), "speed": speed}


def _lab_speed(desc: Mapping, field: str, label: str) -> int:
    value = _num(_require(desc, field, label, f"LabDesc.{field}"), label, f"LabDesc.{field}")
    # >= 100 is already 10000-based; anything smaller is the game's float multiplier (1.0 = 1x).
    return _round(value) if value >= MIN_LAB_RAW_SPEED else _round(value * SPEED_UNIT)


def _belt(desc: Mapping, label: str) -> dict:
    speed = _num(_require(desc, "speed", label, "BeltDesc.speed"), label, "BeltDesc.speed")
    low, high = BELT_SPEED_RANGE
    if not (low <= speed <= high) or not float(speed).is_integer():
        raise NormalizeError(f"{label}: BeltDesc.speed {speed} is implausible (expected {low}..{high} cells per tick)")
    return {"speed": int(speed)}


def _sorter(item_id: int, desc: Mapping, label: str) -> dict:
    stt = _scaled(desc, "stt", "sttf", STT_UNIT, label, "InserterDesc")
    if stt is None:
        raise NormalizeError(f"{label}: missing field InserterDesc.stt")
    if stt < MIN_SORTER_STT:
        raise NormalizeError(
            f"{label}: InserterDesc.stt {stt} is implausible (>= {MIN_SORTER_STT} expected); check the float-to-int conversion"
        )
    delay = _scaled(desc, "delay", "delayf", STT_UNIT, label, "InserterDesc") or 0
    if "grade" in desc:
        grade = _int(desc["grade"], label, "InserterDesc.grade")
    elif item_id in SORTER_CHAIN:
        grade = SORTER_CHAIN.index(item_id) + 1
    else:
        raise NormalizeError(f"{label}: missing field InserterDesc.grade (item is not in the sorter upgrade chain)")
    return {
        "grade": grade,
        "stt": stt,
        "delay": delay,
        "canStack": _bool(desc.get("canStack", False), label, "InserterDesc.canStack"),
        "stackSize": _int(desc.get("stackSize", 1), label, "InserterDesc.stackSize"),
    }


def _station(desc: Mapping, label: str) -> dict:
    kinds = _require(desc, "maxItemKinds", label, "StationDesc.maxItemKinds")
    return {
        "isStellar": _bool(desc.get("isStellar", False), label, "StationDesc.isStellar"),
        "maxItemKinds": _int(kinds, label, "StationDesc.maxItemKinds"),
        "maxItemCount": _int(desc.get("maxItemCount", 0), label, "StationDesc.maxItemCount"),
        "maxEnergyAcc": _int(desc.get("maxEnergyAcc", 0), label, "StationDesc.maxEnergyAcc"),
        "maxDroneCount": _int(desc.get("maxDroneCount", 0), label, "StationDesc.maxDroneCount"),
        "maxShipCount": _int(desc.get("maxShipCount", 0), label, "StationDesc.maxShipCount"),
    }


def _power(desc: Mapping, label: str) -> dict:
    power = {
        "consumer": _bool(desc.get("consumer", False), label, "PowerDesc.consumer"),
        "workPerTick": _int(desc.get("workEnergyPerTick", 0), label, "PowerDesc.workEnergyPerTick"),
        "idlePerTick": _int(desc.get("idleEnergyPerTick", 0), label, "PowerDesc.idleEnergyPerTick"),
    }
    if _bool(desc.get("node", False), label, "PowerDesc.node"):
        power["node"] = {
            "connectDistance": _num(_require(desc, "connectDistance", label, "PowerDesc.connectDistance"), label, "PowerDesc.connectDistance"),
            "coverRadius": _num(_require(desc, "coverRadius", label, "PowerDesc.coverRadius"), label, "PowerDesc.coverRadius"),
            "powerPoint": _vec(_require(desc, "powerPoint", label, "PowerDesc.powerPoint"), 3, label, "PowerDesc.powerPoint"),
        }
    return power


def _spray_coater(desc: Mapping, label: str) -> dict:
    capacity = _require(desc, "incCapacity", label, "SpraycoaterDesc.incCapacity")
    field = "incItemId" if "incItemId" in desc else "incItemIds"
    ids = _list(_require(desc, field, label, "SpraycoaterDesc.incItemId"), label, f"SpraycoaterDesc.{field}")
    return {
        "incCapacity": _int(capacity, label, "SpraycoaterDesc.incCapacity"),
        "incItemIds": [_int(i, label, "SpraycoaterDesc.incItemId") for i in ids],
    }


def _is_power_pole(power: Mapping) -> bool:
    """`PowerDesc.node` marks every grid member, generators and accumulators included.

    Only nodes that are none of those are poles (Tesla Tower, Wireless Power Tower, Satellite
    Substation); `kind: "powerNode"` is what the layout's pole placement selects from.
    """
    return bool(power.get("node")) and not (power.get("generator") or power.get("accumulator") or power.get("exchanger"))


def _kind(item_id: int, descs: Mapping[str, dict], label: str) -> str:
    """Building kind from the descriptors present (brief order; first match wins)."""
    if "AssemblerDesc" in descs:
        return "production"
    if "LabDesc" in descs:
        return "lab"
    if "BeltDesc" in descs:
        return "belt"  # speed is validated (1..20) when the block is built
    if "InserterDesc" in descs:
        return "sorter"
    if "StationDesc" in descs:
        station = descs["StationDesc"]
        # Orbital collectors and the Advanced Mining Machine reuse StationDesc but are not stations.
        collector = station.get("isCollector", False) or station.get("isVeinCollector", False)
        return "other" if collector else "station"
    if _is_power_pole(descs.get("PowerDesc", {})):
        return "powerNode"
    if "SpraycoaterDesc" in descs:
        return "sprayCoater"
    if "SplitterDesc" in descs or item_id == SPLITTER_ITEM:
        return "splitter"
    if "FractionatorDesc" in descs:
        return "fractionator"
    if "PilerDesc" in descs or item_id == PILER_ITEM:
        return "piler"
    if "StorageDesc" in descs:
        return "storage"
    return "other"


_USAGE_BY_INT = {0: "physics", 1: "build"}


def _collider(raw: Mapping, label: str) -> dict:
    d = clean(raw)
    usage = d.get("usage", "other")
    if isinstance(usage, str):
        usage = usage.lower() if usage.lower() in ("build", "physics") else "other"
    else:
        usage = _USAGE_BY_INT.get(usage, "other")
    return {
        "center": _vec(_require(d, "center", label, "collider.center"), 3, label, "collider.center"),
        "halfExtents": _vec(_require(d, "halfExtents", label, "collider.halfExtents"), 3, label, "collider.halfExtents"),
        "rotation": _vec(d.get("rotation", [0, 0, 0, 1]), 4, label, "collider.rotation"),
        "usage": usage,
    }


def _pose(raw: Mapping, label: str, field: str) -> dict:
    d = clean(raw)
    return {
        "position": _vec(_require(d, "position", label, f"{field}.position"), 3, label, f"{field}.position"),
        "rotation": _vec(_require(d, "rotation", label, f"{field}.rotation"), 4, label, f"{field}.rotation"),
    }


def _geometry(raw: RawBuilding, descs: Mapping[str, dict], label: str) -> dict:
    slot_config = descs.get("SlotConfig", {})
    slot_count = len(slot_config.get("insertPoses") or [])
    port_count = len(slot_config.get("slotPoses") or [])
    try:
        if raw.colliders is None or raw.slot_poses is None or raw.port_poses is None:
            return approx_geometry(descs, slot_count, port_count)
        config = read_config(descs)
    except ValueError as err:
        raise NormalizeError(f"{label}: {err}") from None
    colliders = [_collider(c, label) for c in raw.colliders]
    return {
        "source": "extracted",
        "colliders": colliders,
        "slots": [_pose(p, label, "slotPoses") for p in raw.slot_poses],
        "ports": [_pose(p, label, "portPoses") for p in raw.port_poses],
        "selectCenter": config["selectCenter"],
        "selectSize": config["selectSize"],
        "landPoints": config["landPoints"],
        "multiLevel": config["multiLevel"],
        "multiLevelAllowInserter": config["multiLevelAllowInserter"],
        "lapJoint": config["lapJoint"],
        "blueprintBoxSize": blueprint_box_size(config, [c["halfExtents"] for c in colliders if c["usage"] == "build"]),
    }


def _building(raw: RawBuilding, name_keys: Mapping[int, str], locale: Mapping[str, str]) -> dict:
    name_key = name_keys.get(raw.item_id)
    if name_key is None:
        raise NormalizeError(f"building {raw.item_id}: no item proto with that id")
    label = f"building {raw.item_id} ({name_key})"
    descs = {name: clean(fields) if fields else {} for name, fields in raw.descs.items()}
    kind = _kind(raw.item_id, descs, label)

    building: dict = {
        "itemId": raw.item_id,
        "modelIndex": raw.model_index,
        "name": locale.get(name_key, name_key),
        "kind": kind,
    }
    if "AssemblerDesc" in descs:
        building["production"] = _production(descs["AssemblerDesc"], label)
    if "LabDesc" in descs:
        lab = descs["LabDesc"]
        building["lab"] = {
            "assembleSpeed": _lab_speed(lab, "assembleSpeed", label),
            "researchSpeed": _lab_speed(lab, "researchSpeed", label),
        }
    if "BeltDesc" in descs:
        building["belt"] = _belt(descs["BeltDesc"], label)
    if "InserterDesc" in descs:
        building["sorter"] = _sorter(raw.item_id, descs["InserterDesc"], label)
    if kind == "station":
        building["station"] = _station(descs["StationDesc"], label)
    if "SpraycoaterDesc" in descs:
        building["sprayCoater"] = _spray_coater(descs["SpraycoaterDesc"], label)
    building["power"] = _power(descs.get("PowerDesc", {}), label)
    building["geometry"] = _geometry(raw, descs, label)
    return building


# ---- bundle -----------------------------------------------------------------------------------


def _constants(bundle: RawBundle) -> tuple[dict, dict]:
    constants = copy.deepcopy(DEFAULT_CONSTANTS)
    sources = dict(DEFAULT_CONSTANT_SOURCES)
    for key, value in bundle.constants.items():
        if key not in DEFAULT_CONSTANTS:
            raise NormalizeError(f"unknown constant {key!r}")
        if key not in bundle.constant_sources:
            raise NormalizeError(f"constant {key} is overridden but has no entry in constant_sources")
        constants[key] = copy.deepcopy(value)
    for key, source in bundle.constant_sources.items():
        if key not in DEFAULT_CONSTANTS:
            raise NormalizeError(f"unknown constant {key!r}")
        sources[key] = source
    return constants, sources


def normalize(bundle: RawBundle, extractor_version: str, now_iso: str) -> dict:
    """GameData JSON (plain dicts) for `bundle`; raises `NormalizeError` on bad or missing data."""
    if not bundle.game_version:
        raise NormalizeError("bundle has no game_version")
    if bundle.source not in ("game", "fixture"):
        raise NormalizeError(f"bundle source must be 'game' or 'fixture', got {bundle.source!r}")

    locale = bundle.locale
    items = sorted((_item(i, locale) for i in bundle.items), key=lambda x: x["id"])
    recipes = sorted((_recipe(r, locale) for r in bundle.recipes), key=lambda x: x["id"])
    techs = sorted((_tech(t, locale) for t in bundle.techs), key=lambda x: x["id"])
    name_keys = {i["id"]: i["nameKey"] for i in items}
    buildings = sorted((_building(b, name_keys, locale) for b in bundle.buildings), key=lambda x: x["itemId"])
    for rows, key, kind in ((items, "id", "item"), (recipes, "id", "recipe"), (techs, "id", "tech"), (buildings, "itemId", "building")):
        _check_unique(rows, key, kind)
    constants, sources = _constants(bundle)

    meta: dict = {"schemaVersion": SCHEMA_VERSION, "gameVersion": bundle.game_version}
    if bundle.steam_build_id is not None:
        meta["steamBuildId"] = bundle.steam_build_id
    meta.update({"extractedAt": now_iso, "extractorVersion": extractor_version, "source": bundle.source})
    if bundle.proto_signatures:
        meta["protoSignatures"] = dict(bundle.proto_signatures)

    return {
        "meta": meta,
        "items": items,
        "recipes": recipes,
        "techs": techs,
        "buildings": buildings,
        "constants": constants,
        "constantSources": sources,
    }


def dumps_gamedata(data: dict) -> str:
    """Stable JSON text for committed data: one record per line in the big arrays, UTF-8 verbatim."""
    compact = {"ensure_ascii": False, "separators": (",", ":")}
    parts = []
    for key, value in data.items():
        if isinstance(value, list) and value:
            rows = ",\n".join("  " + json.dumps(row, **compact) for row in value)
            parts.append(f' "{key}": [\n{rows}\n ]')
        else:
            parts.append(f' "{key}": ' + json.dumps(value, **compact))
    return "{\n" + ",\n".join(parts) + "\n}\n"
