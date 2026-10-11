"""Read `GameData.constants` values that live in game code, from the decompiled C# sources.

`parse_constants(sources)` takes type name -> source (see `decompile.decompile_types`) and returns
`(values, sources)` keyed like `constants.DEFAULT_CONSTANTS`. Anything it cannot read is left out, so the
defaults (and their "unverified" source strings) stay. Read:

  Cargo.incTableMilli, Cargo.accTableMilli, Cargo.powerTableRatio   static int arrays
  CargoPath.kCargoLength                                           an int constant

The arrays are accepted as ilspycmd prints them: a field initializer (`= new int[11] { 0, 125, ... };`,
`new[] { ... }`, `[ ... ]`) or an assignment in a static constructor (`incTableMilli = new int[11] { ... };`,
`Cargo.incTableMilli = ...`). Elements must be numeric literals (decimal, hex, optional sign and L / U / F / D
suffix); the declared size, when there is one, must equal the element count. The planner stores these tables as
permille integers, so a table with any non-integer value (for example fractions such as 0.125) is not used and
the default stays; a warning on `report` says so.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from .decompile import strip_comments
from .report import Report

__all__ = ["parse_constants"]

_TABLES = ("incTableMilli", "accTableMilli", "powerTableRatio")  # fields of Cargo; also the constants keys

_NEW_ARRAY = re.compile(r"new\s*(?:[A-Za-z_][\w.]*\s*)?\[\s*(\d*)\s*\]\s*")
_NUMBER = re.compile(
    r"(?P<sign>[+-])?(?:0[xX](?P<hex>[0-9A-Fa-f]+)[uUlL]*|(?P<dec>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[uUlLfFdDmM]*)\Z"
)
_CLOSERS = {"{": "}", "[": "]"}


def _number(text: str) -> int | float | None:
    match = _NUMBER.match(text.strip())
    if match is None:
        return None
    if match.group("hex") is not None:
        value: int | float = int(match.group("hex"), 16)
    else:
        dec = match.group("dec")
        value = float(dec) if re.search(r"[.eE]", dec) else int(dec)
    return -value if match.group("sign") == "-" else value


def _parse_array(text: str, pos: int) -> tuple[list[int] | None, str]:
    """The integer elements of the array initializer starting at `pos`, or `(None, why not)`."""
    declared: int | None = None
    new = _NEW_ARRAY.match(text, pos)
    if new is not None:
        declared = int(new.group(1)) if new.group(1) else None
        pos = new.end()
    if pos >= len(text) or text[pos] not in _CLOSERS:
        return None, "the initializer is not an array literal"
    opener, closer = text[pos], _CLOSERS[text[pos]]
    end = text.find(closer, pos + 1)
    if end < 0 or opener in text[pos + 1 : end]:
        return None, "the array literal is nested or never closes"
    parts = [part.strip() for part in text[pos + 1 : end].split(",")]
    if parts and parts[-1] == "":
        parts.pop()  # trailing comma
    numbers: list[int | float] = []
    for part in parts:
        number = _number(part)
        if number is None:
            return None, f"element {part!r} is not a number literal"
        numbers.append(number)
    if declared is not None and declared != len(numbers):
        return None, f"it declares {declared} elements but lists {len(numbers)}"
    if any(isinstance(n, float) and not n.is_integer() for n in numbers):
        return None, "the values are not all integers (the planner stores permille integers)"
    return [int(n) for n in numbers], ""


def _read_table(text: str, field: str) -> tuple[list[int] | None, str]:
    """The first assignment of `field` in `text` that parses; else `(None, reason)` for the first one that did not."""
    reason = ""
    for match in re.finditer(rf"\b{field}\b\s*=(?!=)\s*", text):
        values, why = _parse_array(text, match.end())
        if values is not None:
            return values, ""
        reason = reason or why
    return None, reason or "not found in the decompiled source"


def _read_cargo_length(text: str) -> tuple[int | None, str]:
    reason = ""
    for match in re.finditer(r"\bkCargoLength\b\s*=(?!=)\s*([^;]*);", text):
        number = _number(match.group(1))
        if isinstance(number, int):
            return number, ""
        reason = reason or f"value {match.group(1).strip()!r} is not an integer literal"
    return None, reason or "not found in the decompiled source"


def parse_constants(sources: Mapping[str, str], report: Report | None = None) -> tuple[dict, dict]:
    """`(values, sources)` for the constants readable from the decompiled `Cargo` and `CargoPath` sources.

    `values` maps `incTableMilli`, `accTableMilli`, `powerTableRatio` (lists of ints) and `cargoLength` (int) to
    what the game code says; `sources` maps the same keys to `"decompiled:Cargo.incTableMilli"` and so on.
    A missing value is absent from both. A type that is in `sources` but lacks a constant, or has one that
    cannot be read, is a warning on `report`; a type that was not decompiled is silent (that was already a
    warning when decompiling).
    """
    values: dict[str, object] = {}
    origins: dict[str, str] = {}

    def record(type_name: str, field: str, key: str, value: object, reason: str) -> None:
        if value is not None:
            values[key] = value
            origins[key] = f"decompiled:{type_name}.{field}"
        elif report is not None:
            report.warn(f"{type_name}.{field}: {reason}; keeping the default for {key}", constant=key)

    cargo = sources.get("Cargo")
    if cargo is not None:
        text = strip_comments(cargo)
        for field in _TABLES:
            table, reason = _read_table(text, field)
            record("Cargo", field, field, table, reason)

    cargo_path = sources.get("CargoPath")
    if cargo_path is not None:
        length, reason = _read_cargo_length(strip_comments(cargo_path))
        record("CargoPath", "kCargoLength", "cargoLength", length, reason)

    return values, origins
