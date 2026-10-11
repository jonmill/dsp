"""Minimal pure-Python blueprint decoder used only by the geometry calibration tests.

Follows docs/research/blueprint-format.md section 3 (body version 1 and 2; legacy and -101
building records). It is deliberately not part of the dsp_extract package: the planner's real
codec lives in the TypeScript app. Hashes are not verified here.
"""

from __future__ import annotations

import base64
import gzip
import struct
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class BpBuilding:
    index: int
    item_id: int
    model_index: int
    area_index: int
    pos: tuple[float, float, float]
    yaw: float
    pos2: tuple[float, float, float]
    yaw2: float
    output_obj_idx: int
    input_obj_idx: int
    output_to_slot: int
    input_from_slot: int
    output_from_slot: int
    input_to_slot: int
    output_offset: int
    input_offset: int
    recipe_id: int
    filter_id: int
    params: list[int] = field(default_factory=list)


@dataclass
class Blueprint:
    version: int
    areas: list[dict]
    buildings: list[BpBuilding]


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def take(self, fmt: str):
        size = struct.calcsize(fmt)
        values = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += size
        return values if len(values) > 1 else values[0]


def _is_belt(item_id: int) -> bool:
    return 2000 < item_id < 2010


def _is_sorter(item_id: int) -> bool:
    return 2010 < item_id < 2020


def decode_body(raw: bytes) -> Blueprint:
    r = _Reader(raw)
    version = r.take("<i")
    r.take("<iii")  # cursorOffset x, y, cursorTargetArea
    r.take("<ii")  # dragBoxSize
    r.take("<i")  # primaryAreaIdx
    area_count = r.take("<B")
    areas = []
    for _ in range(area_count):
        index, parent, tropic, segments, anchor_x, anchor_y, width, height = r.take("<bbhhhhhh")
        areas.append(
            {
                "index": index,
                "parent": parent,
                "segments": segments,
                "width": width,
                "height": height,
            }
        )
    building_count = r.take("<i")
    if version >= 2:
        pass  # trailer (patch2, reform) follows the buildings; not needed
    buildings = []
    for _ in range(building_count):
        first = r.take("<i")
        if first <= -100:
            marker = first
            if marker != -101:
                raise ValueError(f"unsupported building marker {marker}")
            index = r.take("<i")
            item_id, model_index = r.take("<hh")
            area_index = r.take("<b")
            x, y, z = r.take("<fff")
            yaw = r.take("<f")
            if _is_belt(item_id) or _is_sorter(item_id):
                r.take("<f")  # tilt
            if _is_sorter(item_id):
                r.take("<f")  # pitch
                x2, y2, z2 = r.take("<fff")
                yaw2 = r.take("<f")
                r.take("<ff")  # tilt2, pitch2
            else:
                x2, y2, z2, yaw2 = x, y, z, yaw
        else:
            index = first
            area_index = r.take("<b")
            x, y, z = r.take("<fff")
            x2, y2, z2 = r.take("<fff")
            yaw, yaw2 = r.take("<ff")
            item_id, model_index = r.take("<hh")
        out_idx, in_idx = r.take("<ii")
        out_to, in_from, out_from, in_to, out_off, in_off = r.take("<bbbbbb")
        recipe_id, filter_id, param_count = r.take("<hhh")
        params = list(struct.unpack_from(f"<{param_count}i", r.data, r.pos)) if param_count else []
        r.pos += 4 * param_count
        buildings.append(
            BpBuilding(
                index=index,
                item_id=item_id,
                model_index=model_index,
                area_index=area_index,
                pos=(x, y, z),
                yaw=yaw,
                pos2=(x2, y2, z2),
                yaw2=yaw2,
                output_obj_idx=out_idx,
                input_obj_idx=in_idx,
                output_to_slot=out_to,
                input_from_slot=in_from,
                output_from_slot=out_from,
                input_to_slot=in_to,
                output_offset=out_off,
                input_offset=in_off,
                recipe_id=recipe_id,
                filter_id=filter_id,
                params=params,
            )
        )
    return Blueprint(version=version, areas=areas, buildings=buildings)


def decode_blueprint_string(text: str) -> Blueprint:
    text = text.strip()
    first = text.index('"')
    last = text.rindex('"')
    raw = gzip.decompress(base64.b64decode(text[first + 1 : last]))
    return decode_body(raw)


def load_blueprint(path: Path) -> Blueprint:
    return decode_blueprint_string(path.read_text())
