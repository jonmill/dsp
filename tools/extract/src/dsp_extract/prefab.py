"""Static extraction of one building prefab (GX section 2.6, "Static-extraction plan for geometry").

`PrefabDesc.ReadPrefab` builds the runtime building description from Unity components on the
prefab GameObject. This module re-reads the same components from the serialized assets, through an
`EnvAdapter` (unity_reader.py) so it never imports UnityPy and can be tested with fakes:

  1. `ModelProto.PrefabPath.lower()` is looked up in the `ResourceManager` container.
  2. The hierarchy is walked in `GetComponentsInChildren` order: pre-order depth first, each
     GameObject's components in `m_Component` order, children in `Transform.m_Children` order.
  3. The first instance of each descriptor MonoBehaviour (`*Desc`, `*Config`) is kept by class
     name; it becomes `RawBuilding.descs[<class name>]`.
  4. `SlotConfig.slotPoses` / `insertPoses` are Transform references; each is composed into a
     world pose by walking `m_Father` up to the root (root Transform included).
     NAMING TRAP: `SlotConfig.slotPoses` are the belt PORTS (`RawBuilding.port_poses`) and
     `SlotConfig.insertPoses` are the sorter SLOTS (`RawBuilding.slot_poses`).
  5. Box/Sphere/Capsule colliders become `{center, halfExtents, rotation, usage, shape}` in prefab
     space. Which colliders are "build" colliders is unknown (research gap 1), so the rule is the
     pluggable `classify_collider`; every distinct (layer, trigger, name, shape) seen is written to
     the report together with the decision.
  6. The collider source is the prefab itself unless the container holds exactly one sibling
     "collider" prefab for the model (research gap 2: `ModelProto.ColliderPath` is not decompiled
     yet). That name match is a guess: a guessed prefab that is a null reference, not a GameObject or
     cannot be walked is reported and the main prefab's colliders are used instead. The choice is
     recorded per building.

Any failure sets only the affected part to None (the normalizer then uses approximate geometry for
it) and adds a report entry. Nothing here raises for a single building.

Transform maths (Unity, left-handed, quaternions as (x, y, z, w)). Each Transform's world linear part is the
3x3 matrix `parent.linear * R(local.rotation) * diag(local.scale)`, so
  world.position = parent.position + parent.linear * local.position
  world.rotation = parent.rotation * local.rotation                    (quaternion product, as Unity)
  world.scale    = column lengths of world.linear                      (Unity's `lossyScale`)
This is exact for positions. `lossyScale` is only a faithful description of the matrix when no rotated child sits
under a non-uniformly scaled ancestor at a non-right angle; such a "sheared" Transform is flagged (`Pose.sheared`) and
reported for the colliders that sit on it, whose extents are then approximate (Unity itself approximates them the same way).
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .raw import RawBuilding, vec
from .report import Report

if TYPE_CHECKING:
    from .unity_reader import EnvAdapter

Vec3 = tuple[float, float, float]
Quat = tuple[float, float, float, float]

IDENTITY_ROTATION: Quat = (0.0, 0.0, 0.0, 1.0)
UNIT_SCALE: Vec3 = (1.0, 1.0, 1.0)

TRANSFORM_TYPES = frozenset({"Transform", "RectTransform"})
COLLIDER_SHAPES = {"BoxCollider": "box", "SphereCollider": "sphere", "CapsuleCollider": "capsule"}

# Descriptor MonoBehaviours are the classes named `*Desc` / `*Config` (GX section 2.6 table).
# These are rendering-only (LOD meshes, audio, animation, minimap) and are not kept.
DESCRIPTOR_SUFFIXES = ("Desc", "Config")
IGNORED_DESCRIPTORS = frozenset({"LODModelDesc", "AudioDesc", "AnimDesc", "MinimapConfig"})
# The descriptors normalize.py reads by name. A failure reading one of these is a report ERROR (the
# building would normalize to the wrong kind); any other descriptor class only costs a warning.
CORE_DESCRIPTORS = frozenset(
    {
        "AssemblerDesc", "LabDesc", "BeltDesc", "InserterDesc", "StationDesc", "PowerDesc", "SpraycoaterDesc",
        "SplitterDesc", "FractionatorDesc", "PilerDesc", "StorageDesc", "SlotConfig", "BuildConditionConfig",
    }
)  # fmt: skip
MONOBEHAVIOUR_HEAD_KEYS = ("m_GameObject", "m_Enabled", "m_Script", "m_Name", "m_EditorHideFlags", "m_EditorClassIdentifier")

# Default collider-usage heuristic inputs (research gap 1; edit here once the real rule is known).
BUILD_LAYER_HINTS = ("build",)  # substring of the layer name or GameObject name, case-insensitive
BUILD_LAYER_NUMBERS: frozenset[int] = frozenset()  # layer numbers known to be the build layer

MAX_DEPTH = 64
MAX_GAME_OBJECTS = 5000
MAX_DETAILS = 12  # collider details kept per building in the report
ROUND_DIGITS = 6


class PrefabError(Exception):
    """One building's prefab could not be read (the message goes to the report)."""


# ---- quaternion and pose maths ----------------------------------------------------------------


def quat_mul(a: Quat, b: Quat) -> Quat:
    """Hamilton product `a * b`: the rotation that applies `b` first, then `a`."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def quat_normalize(q: Quat) -> Quat:
    length = math.sqrt(sum(c * c for c in q))
    if length < 1e-12:
        return IDENTITY_ROTATION
    return (q[0] / length, q[1] / length, q[2] / length, q[3] / length)


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def quat_rotate(q: Quat, v: Vec3) -> Vec3:
    """`q * v`: rotate vector `v` by unit quaternion `q`."""
    qv: Vec3 = (q[0], q[1], q[2])
    t = _cross(qv, v)
    t = (2 * t[0], 2 * t[1], 2 * t[2])
    c = _cross(qv, t)
    w = q[3]
    return (v[0] + w * t[0] + c[0], v[1] + w * t[1] + c[1], v[2] + w * t[2] + c[2])


Mat3 = tuple[Vec3, Vec3, Vec3]  # rows

SHEAR_COSINE = 1e-4  # world axes closer to perpendicular than this count as perpendicular


def _rotation_matrix(q: Quat) -> Mat3:
    x, y, z, w = q
    return (
        (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
        (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
        (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
    )


def _trs_matrix(rotation: Quat, scale: Vec3) -> Mat3:
    """`R(rotation) * diag(scale)`: the rotation matrix with its columns scaled."""
    r = _rotation_matrix(rotation)
    return tuple((row[0] * scale[0], row[1] * scale[1], row[2] * scale[2]) for row in r)  # type: ignore[return-value]


def _mat_mul(a: Mat3, b: Mat3) -> Mat3:
    return tuple(  # type: ignore[return-value]
        tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)) for i in range(3)
    )


def _mat_vec(m: Mat3, v: Vec3) -> Vec3:
    return (
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    )


def _columns(m: Mat3) -> list[Vec3]:
    return [(m[0][j], m[1][j], m[2][j]) for j in range(3)]


def _norm(v: Vec3) -> float:
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def _is_sheared(m: Mat3) -> bool:
    cols = _columns(m)
    for i, j in ((0, 1), (0, 2), (1, 2)):
        lengths = _norm(cols[i]) * _norm(cols[j])
        dot = sum(a * b for a, b in zip(cols[i], cols[j], strict=True))
        if lengths > 1e-12 and abs(dot) > SHEAR_COSINE * lengths:
            return True
    return False


@dataclass(frozen=True)
class Pose:
    """A world pose. `scale` is Unity's lossyScale; `linear` is the true world rotation*scale matrix.

    A hand-built Pose leaves `linear` as None and means `R(rotation) * diag(scale)`; `compose` always fills it.
    """

    position: Vec3 = (0.0, 0.0, 0.0)
    rotation: Quat = IDENTITY_ROTATION
    scale: Vec3 = UNIT_SCALE
    linear: Mat3 | None = None
    sheared: bool = False

    @property
    def matrix(self) -> Mat3:
        return self.linear if self.linear is not None else _trs_matrix(self.rotation, self.scale)


IDENTITY_POSE = Pose()


def compose(parent: Pose, local: Pose) -> Pose:
    """The world pose of a Transform with `local` pose under a parent whose world pose is `parent`."""
    parent_matrix = parent.matrix
    matrix = _mat_mul(parent_matrix, _trs_matrix(local.rotation, local.scale))
    offset = _mat_vec(parent_matrix, local.position)
    lengths = tuple(_norm(col) for col in _columns(matrix))
    return Pose(
        position=(parent.position[0] + offset[0], parent.position[1] + offset[1], parent.position[2] + offset[2]),
        rotation=quat_normalize(quat_mul(parent.rotation, local.rotation)),
        scale=lengths,  # type: ignore[arg-type]
        linear=matrix,
        sheared=_is_sheared(matrix),
    )


def _r(value: float) -> float:
    return round(value, ROUND_DIGITS) + 0.0  # + 0.0 turns -0.0 into 0.0


def _rounded(values: tuple[float, ...] | list[float]) -> list[float]:
    return [_r(v) for v in values]


# ---- reading Unity trees ----------------------------------------------------------------------


def _vector(tree: Mapping, key: str, n: int, what: str) -> tuple[float, ...]:
    if key not in tree:
        raise PrefabError(f"{what}: missing field {key}")
    try:
        return tuple(float(v) for v in vec(tree[key], n))
    except (ValueError, TypeError) as exc:
        raise PrefabError(f"{what}: field {key} is not a {n}-vector: {tree[key]!r}") from exc


def _local_pose(tree: Mapping, what: str) -> Pose:
    return Pose(
        position=_vector(tree, "m_LocalPosition", 3, what),  # type: ignore[arg-type]
        rotation=_vector(tree, "m_LocalRotation", 4, what),  # type: ignore[arg-type]
        scale=_vector(tree, "m_LocalScale", 3, what),  # type: ignore[arg-type]
    )


def world_pose(adapter: EnvAdapter, transform_obj: Any) -> Pose:
    """World pose of a Transform: its local TRS composed up the `m_Father` chain, root included."""
    chain: list[Pose] = []
    obj = transform_obj
    for _ in range(MAX_DEPTH):
        tree = adapter.read_typetree(obj)
        chain.append(_local_pose(tree, "Transform"))
        father = tree.get("m_Father")
        parent = adapter.deref(father) if father else None
        if parent is None:
            break
        obj = parent
    else:
        raise PrefabError(f"Transform hierarchy is deeper than {MAX_DEPTH} levels (a parent cycle?)")
    pose = IDENTITY_POSE
    for local in reversed(chain):
        pose = compose(pose, local)
    return pose


def _component_ptr(entry: Any) -> Any:
    """The PPtr of a `GameObject.m_Component` entry: `{component: PPtr}` or a `(classID, PPtr)` pair."""
    if isinstance(entry, Mapping):
        if "component" in entry:
            return entry["component"]
        raise PrefabError(f"unrecognised m_Component entry (keys {sorted(entry)})")
    if isinstance(entry, (list, tuple)) and entry:
        return entry[-1]
    raise PrefabError(f"unrecognised m_Component entry {entry!r}")


@dataclass
class GoNode:
    """One visited GameObject (pre-order), with its world pose and components in `m_Component` order."""

    name: str
    path: str
    depth: int
    layer: int
    active: bool
    world: Pose
    components: list[tuple[str, Any]]  # (Unity type name, object)


def walk_hierarchy(adapter: EnvAdapter, root_go: Any) -> list[GoNode]:
    """Every GameObject under `root_go` (itself first) in `GetComponentsInChildren<T>(true)` order."""
    nodes: list[GoNode] = []

    def visit(go_obj: Any, parent: Pose, parent_path: str, depth: int) -> None:
        if depth > MAX_DEPTH:
            raise PrefabError(f"GameObject hierarchy is deeper than {MAX_DEPTH} levels (a child cycle?) at {parent_path}")
        if len(nodes) >= MAX_GAME_OBJECTS:
            raise PrefabError(f"prefab has more than {MAX_GAME_OBJECTS} GameObjects")
        go = adapter.read_typetree(go_obj)
        name = str(go.get("m_Name", ""))
        path = f"{parent_path}/{name}" if parent_path else name
        components: list[tuple[str, Any]] = []
        transform_obj = None
        for entry in go.get("m_Component") or []:
            ptr = _component_ptr(entry)
            obj = adapter.deref(ptr) if ptr else None
            if obj is None:
                continue
            type_name = adapter.type_name(obj)
            components.append((type_name, obj))
            if transform_obj is None and type_name in TRANSFORM_TYPES:
                transform_obj = obj
        if transform_obj is None:
            raise PrefabError(f"GameObject {path!r} has no Transform")
        transform = adapter.read_typetree(transform_obj)
        world = compose(parent, _local_pose(transform, f"Transform of {path!r}"))
        active = go.get("m_IsActive", True)
        nodes.append(
            GoNode(
                name=name,
                path=path,
                depth=depth,
                layer=int(go.get("m_Layer", 0)),
                active=bool(active),
                world=world,
                components=components,
            )
        )
        for child_ptr in transform.get("m_Children") or []:
            child_transform = adapter.deref(child_ptr) if child_ptr else None
            if child_transform is None:
                continue
            child_tree = adapter.read_typetree(child_transform)
            child_go = adapter.deref(child_tree.get("m_GameObject")) if child_tree.get("m_GameObject") else None
            if child_go is None:
                raise PrefabError(f"child Transform of {path!r} has no GameObject")
            visit(child_go, world, path, depth + 1)

    visit(root_go, IDENTITY_POSE, "", 0)
    return nodes


# ---- container lookup -------------------------------------------------------------------------


def _basename(key: str) -> str:
    return key.rsplit("/", 1)[-1]


def _normalise_path(path: str) -> str:
    return path.strip().replace("\\", "/").strip("/").lower()


SAMPLE_KEYS = 20


class ContainerMissError(PrefabError):
    """A Resources path is not in the container and no key looks like it; `sample` is a spread of the real keys."""

    def __init__(self, message: str, sample: list[str]) -> None:
        super().__init__(message)
        self.sample = sample


def _sample_keys(container: Mapping[str, Any], count: int = SAMPLE_KEYS) -> list[str]:
    """`count` keys spread evenly over the sorted container keys (all of them when there are fewer)."""
    keys = sorted(container)
    if len(keys) <= count:
        return keys
    return [keys[i * len(keys) // count] for i in range(count)]


def lookup_container(container: Mapping[str, Any], path: str) -> tuple[str, Any]:
    """`(key, pptr)` for a Resources path: exact lowercase match, else a unique `.../<path>` suffix match.

    A miss raises `PrefabError` naming similar keys; when there are none it raises `ContainerMissError`, whose
    `sample` is a spread of the real container keys (so the report shows what the paths look like).
    """
    key = _normalise_path(path)
    if not key:
        raise PrefabError("empty prefab path")
    if key in container:
        return key, container[key]
    suffix = [k for k in container if k.endswith("/" + key)]
    if len(suffix) == 1:
        return suffix[0], container[suffix[0]]
    base = _basename(key)
    similar = [k for k in container if _basename(k) == base][:5] or [k for k in container if base in k][:5]
    ambiguous = f" ({len(suffix)} suffix matches: {suffix[:5]})" if len(suffix) > 1 else ""
    message = f"{path!r} is not in the ResourceManager container{ambiguous}"
    if similar:
        raise PrefabError(f"{message}; similar container keys: {similar} ({len(container)} keys)")
    raise ContainerMissError(
        f"{message}; no similar container keys ({len(container)} keys, a sample is in container_sample in the report)",
        _sample_keys(container),
    )


def _collider_stem(segment: str) -> str:
    return re.sub(r"collider(s)?", "", segment).strip("-_ ")


def find_collider_prefab(container: Mapping[str, Any], prefab_key: str) -> str | None:
    """The one container key that looks like `prefab_key`'s separate collider prefab, else None.

    A candidate has "collider" in its path and, once "collider" is removed from its last segment,
    the same last segment as the prefab (`.../colliders/<name>`, `<name>-collider`, ...).
    Several candidates are ambiguous and give None.
    """
    base = _basename(prefab_key)
    found = [
        k
        for k in container
        if k != prefab_key and "collider" in k and _collider_stem(_basename(k)) == base
    ]
    return found[0] if len(found) == 1 else None


# ---- collider geometry and usage --------------------------------------------------------------


def classify_collider(
    go_name: str,
    layer: int,
    is_trigger: bool,
    shape: str = "box",
    layer_name: str | None = None,
) -> str:
    """Collider usage: "build" | "physics" | "other". PLUGGABLE; the real rule is unknown (GX gap 1).

    Default heuristic, in order:
      1. a box whose layer number is in `BUILD_LAYER_NUMBERS`, or whose layer name or GameObject
         name contains one of `BUILD_LAYER_HINTS`, is "build" (a trigger included);
      2. any other box that is not a trigger is "build";
      3. a trigger is "other";
      4. everything else (spheres, capsules) is "physics".
    Only boxes are ever "build": the footprint rules (GX 2.6 `buildCollider`) use Build+Box only.
    A replacement takes the same arguments and is passed to `read_building(classify=...)`.
    """
    if shape == "box":
        names = f"{layer_name or ''} {go_name}".lower()
        if layer in BUILD_LAYER_NUMBERS or any(hint in names for hint in BUILD_LAYER_HINTS):
            return "build"
        if not is_trigger:
            return "build"
    if is_trigger:
        return "other"
    return "physics"


ColliderClassifier = Callable[..., str]


def _scaled_abs(scale: Vec3, i: int) -> float:
    return abs(scale[i])


def _collider_geometry(shape: str, tree: Mapping, pose: Pose, what: str) -> tuple[Vec3, Vec3]:
    """`(world center, half extents)` of a Unity collider on a Transform with world `pose`."""
    center = _vector(tree, "m_Center", 3, what)
    offset = _mat_vec(pose.matrix, center)  # type: ignore[arg-type]
    world_center: Vec3 = (
        pose.position[0] + offset[0],
        pose.position[1] + offset[1],
        pose.position[2] + offset[2],
    )
    if shape == "box":
        size = _vector(tree, "m_Size", 3, what)
        half: Vec3 = tuple(abs(size[i]) * _scaled_abs(pose.scale, i) / 2 for i in range(3))  # type: ignore[assignment]
        return world_center, half
    if "m_Radius" not in tree:
        raise PrefabError(f"{what}: missing field m_Radius")
    radius = float(tree["m_Radius"])
    if shape == "sphere":
        r = abs(radius) * max(_scaled_abs(pose.scale, i) for i in range(3))
        return world_center, (r, r, r)
    # capsule: m_Direction 0/1/2 = X/Y/Z axis; the radius scales with the larger cross-axis scale
    if "m_Height" not in tree or "m_Direction" not in tree:
        raise PrefabError(f"{what}: missing field m_Height or m_Direction")
    axis = int(tree["m_Direction"])
    if axis not in (0, 1, 2):
        raise PrefabError(f"{what}: m_Direction {axis} is not 0, 1 or 2")
    cross_axes = [i for i in range(3) if i != axis]
    r = abs(radius) * max(_scaled_abs(pose.scale, i) for i in cross_axes)
    length = max(abs(float(tree["m_Height"])) * _scaled_abs(pose.scale, axis), 2 * r)
    capsule_half = [r, r, r]
    capsule_half[axis] = length / 2
    return world_center, (capsule_half[0], capsule_half[1], capsule_half[2])


# ---- one building -----------------------------------------------------------------------------


def _plain(value: Any) -> Any:
    """JSON-plain copy: bound-PPtr dict subclasses become ordinary dicts, tuples become lists."""
    if isinstance(value, Mapping):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def is_descriptor_class(name: str) -> bool:
    return name not in IGNORED_DESCRIPTORS and name.endswith(DESCRIPTOR_SUFFIXES)


def _pose_list(adapter: EnvAdapter, ptrs: Any, what: str) -> list[dict]:
    if not isinstance(ptrs, (list, tuple)):
        raise PrefabError(f"{what} is not a list: {ptrs!r}")
    poses = []
    for i, ptr in enumerate(ptrs):
        obj = adapter.deref(ptr) if ptr else None
        if obj is None:
            raise PrefabError(f"{what}[{i}] is a null Transform reference")
        type_name = adapter.type_name(obj)
        if type_name not in TRANSFORM_TYPES:
            raise PrefabError(f"{what}[{i}] points at a {type_name}, not a Transform")
        pose = world_pose(adapter, obj)
        poses.append({"position": _rounded(pose.position), "rotation": _rounded(pose.rotation)})
    return poses


def read_building(
    adapter: EnvAdapter,
    model_proto: Mapping,
    item: Mapping,
    report: Report,
    *,
    classify: ColliderClassifier = classify_collider,
) -> RawBuilding:
    """Read one building's descriptors, colliders and slot/port poses; never raises for bad data.

    `model_proto` and `item` are the PascalCase proto dicts (`PrefabPath`; `ID`, `ModelIndex`).
    Parts that fail are None (so the normalizer falls back to approximate geometry for them) and a
    warning is added to `report`; an unreadable prefab also loses the descriptors and is an error.
    `classify` is called as `classify(go_name, layer, is_trigger, shape=..., layer_name=...)`.
    """
    item_id = int(item["ID"])
    model_index = int(item["ModelIndex"])
    prefab_path = str(model_proto.get("PrefabPath") or "")
    label = f"building {item_id} ({item.get('Name', '?')})"
    record: dict[str, Any] = {
        "name_key": item.get("Name"),
        "model_index": model_index,
        "prefab_path": prefab_path,
        "status": "failed",
        "problems": [],
    }
    report.set_building(item_id, record)
    raw = RawBuilding(item_id=item_id, model_index=model_index, descs={})

    def problem(level: str, message: str) -> None:
        record["problems"].append(message)
        getattr(report, level)(f"{label}: {message}", item_id=item_id)

    try:
        container = adapter.container()
        key, pptr = lookup_container(container, prefab_path)
        record["container_key"] = key
        root = adapter.deref(pptr)
        if root is None:
            raise PrefabError(f"container entry {key!r} is a null reference")
        if adapter.type_name(root) != "GameObject":
            raise PrefabError(f"container entry {key!r} is a {adapter.type_name(root)}, expected a GameObject")
        nodes = walk_hierarchy(adapter, root)
    except Exception as exc:  # one building must never abort the extraction
        sample = getattr(exc, "sample", None)
        if sample and report.get("container_sample") is None:
            report.set("container_sample", sample)
        problem("error", f"prefab {prefab_path!r} unreadable, descriptors and geometry lost: {exc}")
        return raw

    kinds: dict[str, int] = {}
    for node in nodes:
        for type_name, _ in node.components:
            kinds[type_name] = kinds.get(type_name, 0) + 1
    record["game_objects"] = len(nodes)
    record["components"] = kinds

    try:
        raw.descs, trees = _read_descriptors(adapter, nodes, problem)
        record["descriptors"] = sorted(raw.descs)

        raw.port_poses, raw.slot_poses = _read_slot_config(adapter, raw.descs, trees, problem)
        record["port_count"] = None if raw.port_poses is None else len(raw.port_poses)
        record["slot_count"] = None if raw.slot_poses is None else len(raw.slot_poses)

        raw.colliders = _read_colliders(adapter, nodes, container, key, item_id, report, classify, record, problem)
    except Exception as exc:  # safety net: a bug here must not abort the other buildings
        problem("error", f"unexpected {type(exc).__name__} while reading the prefab: {exc}")
    parts = (raw.colliders, raw.slot_poses, raw.port_poses)
    record["status"] = "extracted" if all(p is not None for p in parts) else "partial"
    return raw


def _read_descriptors(
    adapter: EnvAdapter, nodes: list[GoNode], problem: Callable[[str, str], None]
) -> tuple[dict[str, dict], dict[str, Mapping]]:
    """First instance of each descriptor MonoBehaviour class, in hierarchy order.

    Returns `(descs, trees)`: `descs` are JSON-plain copies for `RawBuilding.descs`; `trees` are the
    adapter's own results, whose PPtrs are still bound to their file and so can be dereferenced.
    """
    descs: dict[str, dict] = {}
    trees: dict[str, Mapping] = {}
    failed: set[str] = set()
    for node in nodes:
        for type_name, obj in node.components:
            if type_name != "MonoBehaviour":
                continue
            try:
                class_name = adapter.script_class(obj)
            except Exception as exc:
                if "<script>" not in failed:
                    failed.add("<script>")
                    problem("warn", f"cannot resolve a MonoBehaviour script on {node.path!r}: {exc}")
                continue
            if not class_name or not is_descriptor_class(class_name):
                continue
            if class_name in descs or class_name in failed:
                continue
            try:
                tree = adapter.read_typetree(obj)
            except Exception as exc:
                failed.add(class_name)
                level = "error" if class_name in CORE_DESCRIPTORS else "warn"
                problem(level, f"cannot read descriptor {class_name} on {node.path!r}: {exc}")
                continue
            descs[class_name] = {k: _plain(v) for k, v in tree.items() if k not in MONOBEHAVIOUR_HEAD_KEYS}
            trees[class_name] = tree
    return descs, trees


def _read_slot_config(
    adapter: EnvAdapter, descs: dict[str, dict], trees: Mapping[str, Mapping], problem: Callable[[str, str], None]
) -> tuple[list[dict] | None, list[dict] | None]:
    """`(port_poses, slot_poses)`; also swaps `descs["SlotConfig"]` pose references for the poses.

    Ports come from `SlotConfig.slotPoses`, slots from `SlotConfig.insertPoses` (the naming trap).
    """
    config = descs.get("SlotConfig")
    if config is None:
        problem("warn", "no SlotConfig on the prefab; belt ports and sorter slots are not extracted")
        return None, None
    results: dict[str, list[dict] | None] = {}
    for field, meaning in (("slotPoses", "belt ports"), ("insertPoses", "sorter slots")):
        refs = trees["SlotConfig"].get(field)
        if refs is None:
            problem("warn", f"SlotConfig has no field {field} ({meaning}); not extracted")
            results[field] = None
            continue
        try:
            results[field] = _pose_list(adapter, refs, f"SlotConfig.{field}")
        except Exception as exc:
            problem("warn", f"cannot compose SlotConfig.{field} ({meaning}): {exc}")
            results[field] = None
        # Keep the entry count in the descriptor (the normalizer counts these), but as plain data.
        count = len(refs) if isinstance(refs, (list, tuple)) else 0
        config[field] = results[field] if results[field] is not None else [None] * count
    return results["slotPoses"], results["insertPoses"]


def _walk_collider_prefab(adapter: EnvAdapter, container: Mapping[str, Any], key: str) -> list[GoNode]:
    root = adapter.deref(container[key])
    if root is None:
        raise PrefabError("it is a null reference")
    type_name = adapter.type_name(root)
    if type_name != "GameObject":
        raise PrefabError(f"it is a {type_name}, expected a GameObject")
    return walk_hierarchy(adapter, root)


def _read_colliders(
    adapter: EnvAdapter,
    nodes: list[GoNode],
    container: Mapping[str, Any],
    prefab_key: str,
    item_id: int,
    report: Report,
    classify: ColliderClassifier,
    record: dict[str, Any],
    problem: Callable[[str, str], None],
) -> list[dict] | None:
    source = "prefab"
    collider_nodes = nodes
    try:
        separate = find_collider_prefab(container, prefab_key)
        if separate is not None:
            # The name match is a guess (research gap 2), so a prefab that cannot be used is not fatal.
            try:
                collider_nodes = _walk_collider_prefab(adapter, container, separate)
                source = separate
            except Exception as exc:
                record["collider_prefab_unusable"] = {"key": separate, "reason": str(exc)}
                problem("warn", f"guessed collider prefab {separate!r} is unusable ({exc}); using the colliders of the main prefab")
        record["collider_source"] = source

        layer_names = adapter.layer_names()
        colliders: list[dict] = []
        details: list[dict] = []
        ignored: dict[str, int] = {}
        sheared: list[str] = []
        for node in collider_nodes:
            for type_name, obj in node.components:
                shape = COLLIDER_SHAPES.get(type_name)
                if shape is None:
                    if type_name.endswith("Collider"):
                        ignored[type_name] = ignored.get(type_name, 0) + 1
                    continue
                what = f"{type_name} on {node.path!r}"
                tree = adapter.read_typetree(obj)
                if "m_IsTrigger" not in tree:
                    raise PrefabError(f"{what}: missing field m_IsTrigger")
                is_trigger = bool(tree["m_IsTrigger"])
                center, half = _collider_geometry(shape, tree, node.world, what)
                if node.world.sheared and node.path not in sheared:
                    sheared.append(node.path)
                layer_name = layer_names.get(node.layer)
                usage = classify(node.name, node.layer, is_trigger, shape=shape, layer_name=layer_name)
                report.note_collider(
                    layer=node.layer,
                    layer_name=layer_name,
                    is_trigger=is_trigger,
                    name=node.name,
                    shape=shape,
                    usage=usage,
                    item_id=item_id,
                )
                colliders.append(
                    {
                        "center": _rounded(center),
                        "halfExtents": _rounded(half),
                        "rotation": _rounded(node.world.rotation),
                        "usage": usage,
                        "shape": shape,
                    }
                )
                details.append(
                    {
                        "path": node.path,
                        "shape": shape,
                        "layer": node.layer,
                        "is_trigger": is_trigger,
                        "usage": usage,
                        "center": _rounded(center),
                        "halfExtents": _rounded(half),
                    }
                )
        record["colliders"] = {
            "total": len(colliders),
            "build": sum(1 for c in colliders if c["usage"] == "build"),
            "ignored_types": ignored,
        }
        record["collider_details"] = details[:MAX_DETAILS]
        if sheared:
            record["sheared_colliders"] = sheared
            problem(
                "warn",
                f"colliders on {sheared[:3]} sit under a sheared transform (a rotated child under a non-uniformly "
                "scaled ancestor); their extents are approximate",
            )
        if not colliders:
            raise PrefabError(f"no Box/Sphere/Capsule colliders found on {source} (ignored: {ignored or 'none'})")
        if record["colliders"]["build"] == 0:
            raise PrefabError(
                f"none of its {len(colliders)} colliders was classified as a build collider; "
                "see collider_layers_seen in the report"
            )
        return colliders
    except Exception as exc:
        problem("warn", f"colliders not extracted (geometry falls back to approximate): {exc}")
        return None


def describe_prefab(adapter: EnvAdapter, prefab_path: str) -> dict[str, Any]:
    """Hierarchy summary of one prefab for diagnostics (the `inspect` command's prefab walk).

    Raises `PrefabError` when the path is not in the container or the hierarchy cannot be walked.
    """
    key, pptr = lookup_container(adapter.container(), prefab_path)
    root = adapter.deref(pptr)
    if root is None:
        raise PrefabError(f"container entry {key!r} is a null reference")
    game_objects = []
    for node in walk_hierarchy(adapter, root):
        names = []
        for type_name, obj in node.components:
            if type_name == "MonoBehaviour":
                try:
                    type_name = f"MonoBehaviour:{adapter.script_class(obj)}"
                except Exception as exc:
                    type_name = f"MonoBehaviour:<{exc}>"
            names.append(type_name)
        game_objects.append(
            {
                "path": node.path,
                "layer": node.layer,
                "active": node.active,
                "world_position": _rounded(node.world.position),
                "components": names,
            }
        )
    return {"prefab_path": prefab_path, "container_key": key, "game_objects": game_objects}
