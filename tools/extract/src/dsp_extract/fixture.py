"""Build the committed fixture dataset from a dsp-parser dump.

The dump (https://github.com/Martin-Pitt/dsp-parser, `dist/data/`) is a raw proto dump with the
same field names as the game's own protos, so it goes through the same `normalize` path as a real
extraction. It carries no prefab colliders or poses, so every fixture building gets approximate
geometry (Review Focus #5).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from . import __version__
from .normalize import NormalizeError, dumps_gamedata, normalize
from .raw import RawBuilding, RawBundle
from .schema_check import SchemaError, validate_against_schema

EN_US_LCID = 1033
_DESC_KEY = re.compile(r"^_[A-Z]")  # `_AssemblerDesc`, `_SlotConfig`; not `_typeString`, `_descFields`


class FixtureError(Exception):
    """The dump directory is missing a file or holds data of an unexpected shape."""


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise FixtureError(f"dsp-parser dump is missing {path}") from None
    except json.JSONDecodeError as err:
        raise FixtureError(f"{path} is not valid JSON: {err}") from None


def _english_locale(path: Path) -> dict[str, str]:
    for language in _read_json(path):
        if language.get("lcid") == EN_US_LCID:
            return dict(language["strings"])
    raise FixtureError(f"{path} has no en-US (lcid {EN_US_LCID}) strings")


def _building(item: dict) -> RawBuilding:
    descs = {key[1:]: value for key, value in item.items() if _DESC_KEY.match(key)}
    return RawBuilding(
        item_id=item["id"],
        model_index=item["modelIndex"],
        descs=descs,
        colliders=None,
        slot_poses=None,
        port_poses=None,
    )


def load_dump(src: Path) -> tuple[RawBundle, str]:
    """The raw bundle for a dsp-parser directory, and the time the dump was generated."""
    src = Path(src)
    items = _read_json(src / "items.json")
    meta = _read_json(src / "meta.json")
    if "version" not in meta:
        raise FixtureError(f"{src / 'meta.json'} has no version")
    # Buildings are the buildable items that have a prefab model (the Foundation has none).
    buildings = [_building(i) for i in items if i.get("canBuild") and i.get("modelIndex")]
    bundle = RawBundle(
        game_version=meta["version"],
        steam_build_id=None,
        source="fixture",
        items=items,
        recipes=_read_json(src / "recipes.json"),
        techs=_read_json(src / "tech.json"),
        buildings=buildings,
        locale=_english_locale(src / "locale.json"),
        constants={},
        constant_sources={},
        proto_signatures={},
    )
    return bundle, meta.get("generatedAt", "")


def build_fixture(src: Path, schema_path: Path | None = None) -> dict:
    """Normalize a dsp-parser dump into GameData, validating it when `schema_path` is given.

    `meta.extractedAt` is the dump's own generation time, so rebuilding is reproducible.
    """
    bundle, generated_at = load_dump(src)
    data = normalize(bundle, __version__, generated_at or "unknown")
    if schema_path is not None:
        validate_against_schema(data, schema_path)
    return data


def default_schema_path() -> Path:
    """data/schema/gamedata.schema.json of the repository this package is checked out in."""
    return Path(__file__).resolve().parents[4] / "data" / "schema" / "gamedata.schema.json"


def run(src: Path, out: Path, schema_path: Path | None = None) -> int:
    """The `fixture` subcommand: build, validate and write the fixture. Returns a process exit code."""
    schema = schema_path or default_schema_path()
    try:
        data = build_fixture(src, schema)
    except (FixtureError, NormalizeError, SchemaError, FileNotFoundError) as err:
        print(f"dsp-extract fixture: {err}", file=sys.stderr)
        return 1
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dumps_gamedata(data), encoding="utf-8")
    print(
        f"wrote {out}: game {data['meta']['gameVersion']}, {len(data['items'])} items, "
        f"{len(data['recipes'])} recipes, {len(data['techs'])} techs, {len(data['buildings'])} buildings"
    )
    return 0
