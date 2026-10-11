"""Validate extractor output against the JSON Schema the app's zod schema generates."""

from __future__ import annotations

import json
from pathlib import Path

MAX_REPORTED_ERRORS = 10


class SchemaError(Exception):
    """GameData does not match `data/schema/gamedata.schema.json`."""


def _json_path(path) -> str:
    out = "$"
    for part in path:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out


def _sort_part(part) -> tuple:
    """Array indices sort numerically (rows[2] before rows[10]); object keys sort after them."""
    return (0, part, "") if isinstance(part, int) else (1, 0, str(part))


def validate_against_schema(gamedata: dict, schema_path: Path) -> None:
    """Raise `SchemaError` listing the first 10 violations with their JSON paths."""
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        raise SchemaError("schema validation needs jsonschema: pip install -e 'tools/extract[dev]'") from None

    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(gamedata), key=lambda e: [_sort_part(p) for p in e.absolute_path])
    if not errors:
        return
    shown = [f"  {_json_path(e.absolute_path)}: {e.message}" for e in errors[:MAX_REPORTED_ERRORS]]
    if len(errors) > MAX_REPORTED_ERRORS:
        shown.append(f"  ... and {len(errors) - MAX_REPORTED_ERRORS} more")
    count = len(errors)
    raise SchemaError(f"GameData failed schema validation ({count} error{'s' if count != 1 else ''}):\n" + "\n".join(shown))
