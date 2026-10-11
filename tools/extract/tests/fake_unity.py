"""An in-memory `EnvAdapter` plus a prefab builder, imitating what UnityPy hands the readers.

Objects live in one fake file and are addressed by `m_PathID`; a PPtr is the plain dict
`{"m_FileID": 0, "m_PathID": n}` (as `read_typetree` returns it), and `{"m_PathID": 0}` is null.
Vectors are `{x, y, z}` dicts and quaternions `{x, y, z, w}` dicts, as UnityPy yields them.
"""

from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field
from typing import Any

H = math.sqrt(0.5)
YAW_90 = (0.0, H, 0.0, H)  # +90 degrees about +y
YAW_180 = (0.0, 1.0, 0.0, 0.0)
IDENTITY = (0.0, 0.0, 0.0, 1.0)


def approx_list(values, tol: float = 1e-5):
    """`pytest.approx` that also accepts nested lists."""
    import pytest

    if values and isinstance(values[0], (list, tuple)):
        return [pytest.approx(list(v), abs=tol) for v in values]
    return pytest.approx(list(values), abs=tol)


def ptr(path_id: int) -> dict:
    return {"m_FileID": 0, "m_PathID": path_id}


NULL = ptr(0)


def v3(x: float, y: float, z: float) -> dict:
    return {"x": x, "y": y, "z": z}


def q4(q: tuple[float, float, float, float]) -> dict:
    return {"x": q[0], "y": q[1], "z": q[2], "w": q[3]}


class BoundPtr(dict):
    """A PPtr as `read_typetree` returns it: only these can be dereferenced, like the real adapter."""


def bind(value: Any) -> Any:
    if isinstance(value, dict):
        if set(value) == {"m_FileID", "m_PathID"}:
            return BoundPtr(value)
        return {k: bind(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [bind(v) for v in value]
    return value


@dataclass
class FakeObject:
    path_id: int
    kind: str  # Unity type name: "GameObject", "Transform", "MonoBehaviour", "BoxCollider", ...
    tree: dict
    script: str | None = None  # MonoScript class name for a MonoBehaviour


@dataclass
class FakeEnv:
    """The `EnvAdapter` protocol over `objects`; fields below inject failures and fixed answers."""

    component_style: str = "dict"  # "dict" -> {component: PPtr}; "pair" -> (classID, PPtr)
    objects: dict[int, FakeObject] = field(default_factory=dict)
    container_map: dict[str, dict] = field(default_factory=dict)
    layers: dict[int, str] = field(default_factory=dict)
    script_errors: set[int] = field(default_factory=set)
    tree_errors: dict[int, Exception] = field(default_factory=dict)
    _next: int = 1

    def add(self, kind: str, tree: dict, script: str | None = None) -> dict:
        path_id = self._next
        self._next += 1
        self.objects[path_id] = FakeObject(path_id, kind, tree, script)
        return ptr(path_id)

    # ---- EnvAdapter ---------------------------------------------------------------------------

    def objects_of_type(self, type_name: str):
        return [o for o in self.objects.values() if o.kind == type_name]

    def type_name(self, obj: FakeObject) -> str:
        return obj.kind

    def script_class(self, obj: FakeObject) -> str | None:
        if obj.path_id in self.script_errors:
            raise RuntimeError("script not resolvable")
        return obj.script

    def read_typetree(self, obj: FakeObject) -> dict:
        if obj.path_id in self.tree_errors:
            raise self.tree_errors[obj.path_id]
        return bind(copy.deepcopy(obj.tree))

    def deref(self, pptr: dict) -> FakeObject | None:
        if pptr["m_PathID"] == 0:
            return None
        if not isinstance(pptr, BoundPtr):
            raise ValueError("PPtr was not read through this adapter, so its file is unknown")
        return self.objects[pptr["m_PathID"]]

    def object(self, pointer: dict) -> FakeObject:
        """Test-side lookup of an object from a plain pointer (what the builder returns)."""
        return self.objects[pointer["m_PathID"]]

    def container(self) -> dict[str, dict]:
        return {key: BoundPtr(value) for key, value in self.container_map.items()}

    def layer_names(self) -> dict[int, str]:
        return self.layers


@dataclass
class Node:
    name: str
    go: dict  # PPtr to the GameObject
    transform: dict  # PPtr to its Transform


class PrefabBuilder:
    """Builds GameObject / Transform / component objects into a `FakeEnv`."""

    def __init__(self, env: FakeEnv) -> None:
        self.env = env

    def game_object(
        self,
        name: str,
        parent: Node | None = None,
        pos: tuple[float, float, float] = (0, 0, 0),
        rot: tuple[float, float, float, float] = IDENTITY,
        scale: tuple[float, float, float] = (1, 1, 1),
        layer: int = 0,
        active: bool = True,
    ) -> Node:
        go = self.env.add("GameObject", {"m_Name": name, "m_Layer": layer, "m_IsActive": active, "m_Component": []})
        transform = self.env.add(
            "Transform",
            {
                "m_GameObject": go,
                "m_LocalPosition": v3(*pos),
                "m_LocalRotation": q4(rot),
                "m_LocalScale": v3(*scale),
                "m_Children": [],
                "m_Father": parent.transform if parent else NULL,
            },
        )
        node = Node(name, go, transform)
        self._attach(node, transform)
        if parent:
            self.env.objects[parent.transform["m_PathID"]].tree["m_Children"].append(transform)
        return node

    def _attach(self, node: Node, component: dict) -> None:
        components = self.env.objects[node.go["m_PathID"]].tree["m_Component"]
        if self.env.component_style == "pair":
            components.append((4, component))
        else:
            components.append({"component": component})

    def component(self, node: Node, kind: str, tree: dict, script: str | None = None) -> dict:
        tree = {"m_GameObject": node.go, **tree}
        pointer = self.env.add(kind, tree, script)
        self._attach(node, pointer)
        return pointer

    def mono(self, node: Node, script: str, **fields: Any) -> dict:
        head = {"m_Enabled": 1, "m_Script": ptr(9999), "m_Name": ""}
        return self.component(node, "MonoBehaviour", {**head, **fields}, script=script)

    def box(self, node: Node, center=(0, 0, 0), size=(1, 1, 1), trigger: bool = False) -> dict:
        return self.component(
            node,
            "BoxCollider",
            {"m_Enabled": True, "m_IsTrigger": trigger, "m_Center": v3(*center), "m_Size": v3(*size)},
        )

    def sphere(self, node: Node, center=(0, 0, 0), radius: float = 1.0, trigger: bool = False) -> dict:
        return self.component(
            node,
            "SphereCollider",
            {"m_Enabled": True, "m_IsTrigger": trigger, "m_Center": v3(*center), "m_Radius": radius},
        )

    def capsule(self, node: Node, center=(0, 0, 0), radius=0.5, height=2.0, direction=1, trigger=False) -> dict:
        return self.component(
            node,
            "CapsuleCollider",
            {
                "m_Enabled": True,
                "m_IsTrigger": trigger,
                "m_Center": v3(*center),
                "m_Radius": radius,
                "m_Height": height,
                "m_Direction": direction,
            },
        )

    def publish(self, root: Node, resources_path: str) -> None:
        """Register `root` in the ResourceManager container (keys are lowercase)."""
        self.env.container_map[resources_path.lower()] = root.go
