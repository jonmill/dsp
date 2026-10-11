"""Write JSON files so that a crash or a bad value never leaves a half-written or corrupted file behind."""

from __future__ import annotations

import json
import math
import os
import tempfile
from collections.abc import Callable
from pathlib import Path

from .normalize import dumps_gamedata

__all__ = ["dumps_json", "write_atomic"]

DEFAULT_FILE_MODE = 0o644


def dumps_json(data: dict) -> str:
    """Sorted, indented JSON with a trailing newline (small committed files such as fingerprints.json)."""
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _reject_constant(name: str):
    raise ValueError(name)


def _non_finite_path(value: object, path: str = "$") -> str | None:
    """JSON path of the first NaN or infinity inside `value`, or None."""
    if isinstance(value, float) and not math.isfinite(value):
        return path
    if isinstance(value, dict):
        for key, item in value.items():
            found = _non_finite_path(item, f"{path}.{key}")
            if found:
                return found
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            found = _non_finite_path(item, f"{path}[{index}]")
            if found:
                return found
    return None


def write_atomic(path: Path, data: dict, dumps: Callable[[dict], str] = dumps_gamedata) -> None:
    """Write `dumps(data)` to `path` through a tmp file in the same folder and `os.replace`.

    The text is produced and checked first (it must parse back as strict JSON, so NaN and Infinity are
    rejected), then written, flushed and fsynced to `<path>.<random>.tmp`, then renamed over `path`. On any
    exception the tmp file is removed and an existing `path` keeps its old content.
    """
    path = Path(path)
    text = dumps(data)
    try:
        json.loads(text, parse_constant=_reject_constant)
    except ValueError as exc:
        where = _non_finite_path(data)
        at = f" at {where}" if where else ""
        raise ValueError(f"refusing to write {path.name}: not valid JSON ({exc} is not allowed{at})") from None

    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        mode = DEFAULT_FILE_MODE
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
