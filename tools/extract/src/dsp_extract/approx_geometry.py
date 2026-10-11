"""Approximate building geometry, used until real prefab extraction supplies colliders and poses.

Everything here is a deterministic function of a building's `SlotConfig` / `BuildConditionConfig`
descriptors. Output always carries `source: "approximate"` and is flagged as such in every
generated blueprint (Review Focus #5). Prefab space is Unity axes in metres: `x` right, `y` up,
`z` forward; yaw 0 faces +z, yaw 90 faces +x (clockwise seen from above), as a quaternion about +y.
"north" below means +z, "east" +x, "south" -z, "west" -x.

Footprint and colliders
  * Half-extents `hx, hz` are the max |x| and |z| over `BuildConditionConfig.landPoints` when there
    are at least two points; otherwise `SlotConfig.selectSize / 2 - 0.1`. Height `hy` is
    `selectSize.y / 2`. One `build` collider, centre `(selectCenter.x, hy, selectCenter.z)`, identity
    rotation.
  * Cross-shaped land points (all of `(+-a, +-b)` and `(+-b, +-a)` present, `a > b > 0`, e.g. the
    PLS/ILS `(+-4, +-2)` + `(+-2, +-4)`) give two build boxes, `(a, hy, b)` and `(b, hy, a)`. The
    `b > 0` condition keeps diamond layouts such as the splitter's `(0, +-1.28), (+-1.28, 0)` as a
    single box; without it they would degenerate into two zero-thickness boxes.
  * `blueprintBoxSize` is `SlotConfig`-independent: `BuildConditionConfig.blueprintBoxSizeOverride`
    when either component is at least 0.25, else `(2 * max hx, 2 * max hz)` over the build boxes.

Sorter slots (`n = len(SlotConfig.insertPoses)`), pose y = 0, rotation faces outward
  * n = 12 (assemblers, smelters, labs, storage): three per side, centre at normal offset 1.11 m,
    lateral offsets -1.0, 0, +1.0 m. Indexed clockwise starting at the north side's west slot:
    north 0 (W) 1 2 (E); east 3 (N) 4 5 (S); south 6 (E) 7 8 (W); west 9 (S) 10 11 (N).
  * n = 8 (chemical plants): four on each long side (north/south when `hx >= hz`, else east/west),
    lateral offsets -1.5, -0.5, 0.5, 1.5 tiles, normal offset `half-extent - 0.9` m, clockwise.
  * n = 9 (refinery, collider): three per side on north, east and south, lateral -1, 0, +1 tile,
    normal offset `half-extent - 0.9` m, clockwise.
  * other n: round-robin over north, east, south, west (slot i goes to side i % 4), lateral offsets
    centred on 0 and one tile apart, normal offset `half-extent - 0.9` m.

Belt ports (`m = len(SlotConfig.slotPoses)`), pose y = 0, rotation faces outward
  * m = 12 (PLS, ILS): three per side at normal offset 2.70 m, lateral -TILE, 0, +TILE. Indexed
    counter-clockwise starting at the north side's east port: north 0 (E) 1 2 (W); west 3 (N) 4 5 (S);
    south 6 (W) 7 8 (E); east 9 (S) 10 11 (N).
  * other m (splitter m = 4 gives one port per side at lateral 0): the same round-robin as slots.

Derived numbers (calibration against docs/research/blueprint-samples, tests/test_approx_geometry.py)
  * Assembler Mk.II, 36 sorter ends across all 8 assemblers of the capsule sample (all yaw 0): slot 3
    (1.10..1.11, +1.0), slot 4 (1.10..1.11, 0), slot 5 (1.10..1.11, -1.0), slot 9 (-1.11, -1.0),
    slot 10 (-1.11, 0), slot 11 (-1.11, +1.0). Worst error against this module is under 0.01 m.
    North/south slots (0-2, 6-8) were never used by that sample; they follow the east/west pattern
    and the brief's clockwise order and are unverified. Applying 1.11 m to every n = 12 building
    (smelter, lab, storage) is an extrapolation from the assembler.
  * ILS (yaw 0, 12 belts): ports sit at normal offset 2.692..2.718 m (mean 2.70 m) and lateral
    0 or +-1.246..1.271 m (TILE = 1.2566 m), in the counter-clockwise order above. Worst error
    against this module is about 0.03 m. The PLS shares the numbers (same model family), unverified.
  * Slot and port rotations follow "outward = +z of the pose"; the game's own sorter facing is
    `rotation * (0, 0, -1)` (GX section 2.6), so a consumer that needs the in-game facing must
    account for that. Unverified in-game.
  * Splitter ports, n = 9 / n = 8 slots and all fallback layouts are guesses with no sample behind
    them.
"""

from __future__ import annotations

from .constants import TILE_METERS
from .raw import clean, vec

TILE = TILE_METERS

# Sides in clockwise order seen from above (+z up): north, east, south, west.
_NORTH, _EAST, _SOUTH, _WEST = "N", "E", "S", "W"
_CLOCKWISE = (_NORTH, _EAST, _SOUTH, _WEST)
_COUNTER_CLOCKWISE = (_NORTH, _WEST, _SOUTH, _EAST)

_H = 0.7071067811865476  # sqrt(1/2)
# Outward-facing rotation about +y per side: yaw 0 / 90 / 180 / 270 as (x, y, z, w).
_OUTWARD = {
    _NORTH: [0.0, 0.0, 0.0, 1.0],
    _EAST: [0.0, _H, 0.0, _H],
    _SOUTH: [0.0, 1.0, 0.0, 0.0],
    _WEST: [0.0, _H, 0.0, -_H],
}

_ASSEMBLER_SLOT_NORMAL = 1.11
_ASSEMBLER_SLOT_LATERAL = 1.0
_STATION_PORT_NORMAL = 2.70
_EDGE_INSET = 0.9
_MIN_BLUEPRINT_OVERRIDE = 0.25

_DEFAULT_SELECT_CENTER = [0.0, 0.5, 0.0]
_DEFAULT_SELECT_SIZE = [1.0, 1.0, 1.0]


def _num(v: float) -> float:
    return round(v, 6) + 0.0  # + 0.0 turns -0.0 into 0.0


def read_config(descs: dict[str, dict]) -> dict:
    """The static geometry fields of GameData, read from SlotConfig / BuildConditionConfig.

    Missing configs fall back to a 1 m cube resting on the ground (only synthetic test buildings
    lack a SlotConfig; every real prefab has one).
    """
    slot = clean(descs.get("SlotConfig") or {})
    cond = clean(descs.get("BuildConditionConfig") or {})
    assert isinstance(slot, dict) and isinstance(cond, dict)
    return {
        "selectCenter": vec(slot.get("selectCenter", _DEFAULT_SELECT_CENTER), 3),
        "selectSize": vec(slot.get("selectSize", _DEFAULT_SELECT_SIZE), 3),
        "landPoints": [vec(p, 3) for p in cond.get("landPoints", [])],
        "multiLevel": bool(cond.get("multiLevel", False)),
        "multiLevelAllowInserter": bool(cond.get("multiLevelAllowInserter", False)),
        "lapJoint": vec(cond.get("lapJoint", [0, 0, 0]), 3),
        "blueprintBoxSizeOverride": vec(cond.get("blueprintBoxSizeOverride", [0, 0]), 2),
    }


def blueprint_box_size(config: dict, build_half_extents: list[list[float]]) -> list[float]:
    """GX section 2.6 step 4: the override if large enough, else the build collider footprint."""
    override = config["blueprintBoxSizeOverride"]
    if override[0] >= _MIN_BLUEPRINT_OVERRIDE or override[1] >= _MIN_BLUEPRINT_OVERRIDE:
        return override
    if not build_half_extents:
        return [0.0, 0.0]
    return [_num(2 * max(h[0] for h in build_half_extents)), _num(2 * max(h[2] for h in build_half_extents))]


def _cross_extents(points: list[list[float]]) -> tuple[float, float] | None:
    """`(a, b)` with a > b > 0 when land points hold all of (+-a, +-b) and (+-b, +-a), else None."""
    pts = {(round(p[0], 4), round(p[2], 4)) for p in points}
    best: tuple[float, float] | None = None
    for x, z in pts:
        a, b = abs(x), abs(z)
        if a - b <= 1e-6 or b <= 1e-6:
            continue
        needed = {(sx * a, sz * b) for sx in (1, -1) for sz in (1, -1)}
        needed |= {(sx * b, sz * a) for sx in (1, -1) for sz in (1, -1)}
        if needed <= pts and (best is None or a > best[0]):
            best = (a, b)
    return best


def _boxes(config: dict) -> list[tuple[float, float]]:
    """Footprint half-extents `(hx, hz)` of each build box."""
    points = config["landPoints"]
    if len(points) >= 2:
        cross = _cross_extents(points)
        if cross is not None:
            a, b = cross
            return [(a, b), (b, a)]
        return [(max(abs(p[0]) for p in points), max(abs(p[2]) for p in points))]
    size = config["selectSize"]
    return [(max(size[0] / 2 - 0.1, 0.0), max(size[2] / 2 - 0.1, 0.0))]


def _colliders(config: dict, boxes: list[tuple[float, float]]) -> list[dict]:
    hy = config["selectSize"][1] / 2
    cx, _, cz = config["selectCenter"]
    return [
        {
            "center": [_num(cx), _num(hy), _num(cz)],
            "halfExtents": [_num(hx), _num(hy), _num(hz)],
            "rotation": [0.0, 0.0, 0.0, 1.0],
            "usage": "build",
        }
        for hx, hz in boxes
    ]


def _pose(side: str, normal: float, lateral_cw: float) -> dict:
    """Pose on `side` at `normal` metres out and `lateral_cw` along that side in clockwise order."""
    if side == _NORTH:
        position = (lateral_cw, normal)
    elif side == _EAST:
        position = (normal, -lateral_cw)
    elif side == _SOUTH:
        position = (-lateral_cw, -normal)
    else:
        position = (-normal, lateral_cw)
    return {"position": [_num(position[0]), 0.0, _num(position[1])], "rotation": list(_OUTWARD[side])}


def _centred(count: int, spacing: float) -> list[float]:
    return [(j - (count - 1) / 2) * spacing for j in range(count)]


def _blocks(layout: list[tuple[str, list[float], float]]) -> list[dict]:
    """Poses for consecutive `(side, lateral offsets, normal offset)` blocks, in index order."""
    return [_pose(side, normal, t) for side, laterals, normal in layout for t in laterals]


def _edge(side: str, hx: float, hz: float) -> float:
    """Normal offset for edge-relative layouts: the half-extent along the side's normal, minus 0.9 m."""
    return max((hz if side in (_NORTH, _SOUTH) else hx) - _EDGE_INSET, 0.0)


def _round_robin(count: int, hx: float, hz: float) -> list[dict]:
    poses = []
    for i in range(count):
        side = _CLOCKWISE[i % 4]
        on_side = (count - (i % 4) + 3) // 4  # how many indices land on this side
        poses.append(_pose(side, _edge(side, hx, hz), _centred(on_side, TILE)[i // 4]))
    return poses


def _slot_poses(count: int, hx: float, hz: float) -> list[dict]:
    if count == 12:
        laterals = [-_ASSEMBLER_SLOT_LATERAL, 0.0, _ASSEMBLER_SLOT_LATERAL]
        return _blocks([(side, laterals, _ASSEMBLER_SLOT_NORMAL) for side in _CLOCKWISE])
    if count == 8:
        long_sides = (_NORTH, _SOUTH) if hx >= hz else (_EAST, _WEST)
        laterals = [-1.5 * TILE, -0.5 * TILE, 0.5 * TILE, 1.5 * TILE]
        return _blocks([(side, laterals, _edge(side, hx, hz)) for side in long_sides])
    if count == 9:
        laterals = [-TILE, 0.0, TILE]
        return _blocks([(side, laterals, _edge(side, hx, hz)) for side in (_NORTH, _EAST, _SOUTH)])
    return _round_robin(count, hx, hz)


def _port_poses(count: int, hx: float, hz: float) -> list[dict]:
    if count == 12:
        # Counter-clockwise from the north side's east port: lateral runs against the clockwise axis.
        laterals = [TILE, 0.0, -TILE]
        return _blocks([(side, laterals, _STATION_PORT_NORMAL) for side in _COUNTER_CLOCKWISE])
    return _round_robin(count, hx, hz)


def approx_geometry(descs: dict[str, dict], slot_count: int, port_count: int) -> dict:
    """GameData `geometry` with `source: "approximate"` (rules in the module docstring)."""
    config = read_config(descs)
    boxes = _boxes(config)
    hx = max(b[0] for b in boxes)
    hz = max(b[1] for b in boxes)
    colliders = _colliders(config, boxes)
    return {
        "source": "approximate",
        "colliders": colliders,
        "slots": _slot_poses(slot_count, hx, hz),
        "ports": _port_poses(port_count, hx, hz),
        "selectCenter": config["selectCenter"],
        "selectSize": config["selectSize"],
        "landPoints": config["landPoints"],
        "multiLevel": config["multiLevel"],
        "multiLevelAllowInserter": config["multiLevelAllowInserter"],
        "lapJoint": config["lapJoint"],
        "blueprintBoxSize": blueprint_box_size(config, [c["halfExtents"] for c in colliders]),
    }
