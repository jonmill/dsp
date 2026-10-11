"""Decompile selected game types with ilspycmd, fingerprint the methods the TS code mirrors, and report drift.

Flow (Task 7 wires it into the CLI):
  1. `find_ilspycmd` / `decompile_types` write `local/decompiled/<Type>.cs`; `rotate_previous` first moves the
     last run to `local/decompiled.prev/` so `drift_report` can show a diff.
  2. `build_fingerprints` hashes each method of `mirrored_methods.MIRRORED` (`extract_method` +
     `normalize_body` + `fingerprint`) into the `data/fingerprints.json` document:
         {"gameVersion": str, "methods": {"<Type.Method>": {"sha256": str, "tsModule": str}}}
  3. `drift_report(old, new, MIRRORED)` lists the methods whose hash changed, vanished or appeared, with the
     TS module to re-check for each.

ilspycmd cannot decompile a single method, so the C# text is cut apart here. `_scan` is a small C# lexer
(line and block comments, regular / verbatim / interpolated / raw strings, char literals, preprocessor lines)
used for three things: blanking those spans so braces and names inside them are never seen (`_analyze`),
removing comments (`normalize_body`) and finding the end of a member by brace matching (`extract_method`).
"""

from __future__ import annotations

import difflib
import hashlib
import re
import shutil
import subprocess
from bisect import bisect_right
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

from .errors import ExtractError
from .mirrored_methods import MIRRORED
from .report import Report

__all__ = [
    "DriftEntry",
    "TYPES_TO_DECOMPILE",
    "build_fingerprints",
    "decompile_types",
    "drift_report",
    "extract_method",
    "find_ilspycmd",
    "fingerprint",
    "load_sources",
    "normalize_body",
    "rotate_previous",
    "strip_comments",
]

ASSEMBLY_NAME = "Assembly-CSharp.dll"
DECOMPILE_TIMEOUT_S = 300.0

# GX §6 "recommended first batch", plus what the readers need: `GameConfig` (game version) and `Cargo` /
# `CargoPath` (code constants), `LabComponent` and `BuildTool_Inserter` (mirrored methods, see MIRRORED).
TYPES_TO_DECOMPILE: list[str] = [
    "PrefabDesc",
    "ColliderData",
    "ModelProto",
    "ItemProto",
    "TechProto",
    "GameHistoryData",
    "InserterComponent",
    "CargoPath",
    "CargoTraffic",
    "AssemblerComponent",
    "SpraycoaterComponent",
    "PowerSystem",
    "StationComponent",
    "BuildTool_Click",
    "BuildTool_Path",
    "BlueprintData",
    "MD5F",
    "GameConfig",
    "Cargo",
    "LabComponent",
    "BuildTool_Inserter",
]

# ---- ilspycmd ---------------------------------------------------------------------------------------

_TYPE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.`+]*\Z")  # `Outer+Inner`, `ProtoSet`1`; nothing path-like


def find_ilspycmd() -> str | None:
    """The `ilspycmd` executable on PATH, or None (`dotnet tool install -g ilspycmd` puts it in ~/.dotnet/tools)."""
    return shutil.which("ilspycmd")


def _first_line(*streams: bytes | str | None) -> str:
    """The first non-empty line (at most 300 characters) of the first stream that has text; `""` if none does."""
    for data in streams:
        if data is None:
            continue
        text = data if isinstance(data, str) else data.decode("utf-8", errors="replace")
        for line in text.splitlines():
            if line.strip():
                return line.strip()[:300]
    return ""


def decompile_types(
    ilspy: str,
    managed_dir: Path,
    types: list[str],
    out_dir: Path,
    report: Report | None = None,
    timeout: float = DECOMPILE_TIMEOUT_S,
) -> dict[str, Path]:
    """Decompile each type of `<managed_dir>/Assembly-CSharp.dll` to `<out_dir>/<Type>.cs`.

    Runs `ilspycmd --disable-updatecheck -r <managed_dir> -t <Type> <managed_dir>/Assembly-CSharp.dll` once per
    type. A type that fails (not in this game version, ilspycmd error, no output, `timeout` seconds exceeded)
    is a warning on `report` (with the first line of ilspycmd's stderr, or of its stdout when stderr is empty,
    also on a timeout) and is left out of the result; the others still decompile. Problems that affect every
    type raise `ExtractError`: no Assembly-CSharp.dll, an ilspycmd that cannot be started, or no type at all
    decompiling (the message carries the first failure). The result maps type name -> written file. Files are
    written with `\\n` line endings.
    """
    managed_dir = Path(managed_dir)
    out_dir = Path(out_dir)
    dll = managed_dir / ASSEMBLY_NAME
    if not dll.is_file():
        raise ExtractError(f"{ASSEMBLY_NAME} not found in {managed_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, Path] = {}
    failed: dict[str, str] = {}

    def fail(type_name: str, reason: str) -> None:
        failed[type_name] = reason
        if report is not None:
            report.warn(f"ilspycmd could not decompile {type_name}: {reason}", type=type_name)

    for type_name in types:
        if not _TYPE_NAME.match(type_name):
            fail(type_name, "not a usable type name")
            continue
        target = out_dir / f"{type_name}.cs"
        target.unlink(missing_ok=True)  # never leave the last run's file looking like this run's
        command = [ilspy, "--disable-updatecheck", "-r", str(managed_dir), "-t", type_name, str(dll)]
        try:
            proc = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            partial = _first_line(exc.stderr, exc.stdout)
            fail(type_name, f"timed out after {timeout:g} s" + (f": {partial}" if partial else ""))
            continue
        except OSError as exc:
            raise ExtractError(f"cannot run ilspycmd ({ilspy}): {exc}") from exc
        if proc.returncode != 0:
            fail(type_name, f"exit code {proc.returncode}: {_first_line(proc.stderr, proc.stdout) or 'no error text'}")
            continue
        text = proc.stdout.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
        if not text.strip():
            fail(type_name, "no output")
            continue
        target.write_text(text, encoding="utf-8", newline="\n")
        result[type_name] = target

    if report is not None:
        report.set("decompile", {"ilspycmd": ilspy, "decompiled": list(result), "failed": failed})
        report.info(f"decompiled {len(result)} of {len(types)} types with ilspycmd")
    if types and not result:
        first_type, first_reason = next(iter(failed.items()))
        raise ExtractError(f"ilspycmd produced no output for any type: {first_type}: {first_reason}")
    return result


def load_sources(directory: Path) -> dict[str, str]:
    """`<Type>.cs` files of a decompile directory as type name -> C# source (empty if there is no directory)."""
    directory = Path(directory)
    if not directory.is_dir():
        return {}
    files = sorted(directory.glob("*.cs"))
    return {p.name[: -len(".cs")]: p.read_text(encoding="utf-8", errors="replace") for p in files}


def rotate_previous(directory: Path) -> Path | None:
    """Keep the last decompile: rename `directory` (`local/decompiled`) to `<directory>.prev`, replacing an older one.

    Returns the new path, or None when there was nothing to rotate. Call it before a new `decompile_types` run.
    """
    directory = Path(directory)
    if not directory.is_dir():
        return None
    previous = directory.with_name(directory.name + ".prev")
    if previous.exists():
        shutil.rmtree(previous)
    directory.rename(previous)
    return previous


# ---- C# lexing ------------------------------------------------------------------------------------------

_INTERESTING = re.compile(r"""[/"'@$#]""")
_SENT_OPEN, _SENT_CLOSE = "", ""  # private-use markers that shield a literal from whitespace collapsing


def _char_end(src: str, i: int) -> int:
    """End of the char literal starting at `i` (`'{'`, `'\\''`, `'\\u0041'`); at least `i + 1`."""
    n = len(src)
    k = i + 1
    if k < n and src[k] == "\\":
        k += 2
    elif k < n:
        k += 1
    while k < n and src[k] not in "'\n" and k - i < 12:
        k += 1
    return k + 1 if k < n and src[k] == "'" else max(min(k, n), i + 1)


def _hole_end(src: str, k: int) -> int:
    """End of an interpolation hole whose `{` precedes `k`: the index after the matching `}`."""
    n = len(src)
    depth = 1
    while k < n:
        ch = src[k]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return k + 1
        elif ch in "\"'@$":
            end = _literal_end(src, k)
            if end is not None:
                k = end
                continue
        k += 1
    return n


def _string_end(src: str, quote: int, interpolated: bool, verbatim: bool) -> int:
    """End of the string whose opening `"` is at `quote` (an unterminated regular string stops at the newline)."""
    n = len(src)
    k = quote + 1
    while k < n:
        ch = src[k]
        if ch == '"':
            if verbatim and k + 1 < n and src[k + 1] == '"':
                k += 2
                continue
            return k + 1
        if ch == "\\" and not verbatim:
            k += 2
            continue
        if ch == "\n" and not verbatim:
            return k
        if interpolated and ch == "{":
            if k + 1 < n and src[k + 1] == "{":
                k += 2
                continue
            k = _hole_end(src, k + 1)
            continue
        k += 1
    return n


def _literal_end(src: str, i: int) -> int | None:
    """If a string or char literal starts at `i` (with its `@` / `$` prefixes), the index after it, else None."""
    n = len(src)
    if src[i] == "'":
        return _char_end(src, i)
    j = i
    interpolated = verbatim = False
    while j < n and j - i < 2 and src[j] in "@$":
        if src[j] == "@":
            verbatim = True
        else:
            interpolated = True
        j += 1
    if j >= n or src[j] != '"':
        return None
    if not verbatim:
        quotes = 1
        while j + quotes < n and src[j + quotes] == '"':
            quotes += 1
        if quotes == 2:
            return j + 2  # ""
        if quotes >= 3:  # raw string literal: ends at the next run of as many quotes
            end = src.find('"' * quotes, j + quotes)
            return n if end < 0 else end + quotes
    return _string_end(src, j, interpolated, verbatim)


def _scan(src: str) -> list[tuple[int, int, str]]:
    """Spans `(start, end, kind)` of every comment (`"comment"`) and string / char / preprocessor line (`"literal"`)."""
    spans: list[tuple[int, int, str]] = []
    n = len(src)
    i = 0
    while i < n:
        match = _INTERESTING.search(src, i)
        if match is None:
            break
        i = match.start()
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] in "/*":
            if src[i + 1] == "/":
                end = src.find("\n", i)
                end = n if end < 0 else end
            else:
                end = src.find("*/", i + 2)
                end = n if end < 0 else end + 2
            spans.append((i, end, "comment"))
            i = end
            continue
        if c == "#":
            if not src[src.rfind("\n", 0, i) + 1 : i].strip():  # `#if`, `#region`, ... at the start of a line
                end = src.find("\n", i)
                end = n if end < 0 else end
                spans.append((i, end, "literal"))
                i = end
                continue
        elif c != "/":
            end = _literal_end(src, i)
            if end is not None:
                spans.append((i, end, "literal"))
                i = end
                continue
        i += 1
    return spans


def _blank(src: str, spans: list[tuple[int, int, str]]) -> str:
    """`src` with every span replaced by spaces (newlines kept), so offsets still line up with `src`."""
    chars = list(src)
    for start, end, _ in spans:
        chars[start:end] = re.sub(r"[^\r\n]", " ", src[start:end])
    return "".join(chars)


def strip_comments(src: str) -> str:
    """`src` without its comments (a comment becomes a space, or the newlines it contained)."""
    pieces: list[str] = []
    pos = 0
    for start, end, kind in _scan(src):
        if kind != "comment":
            continue
        pieces.append(src[pos:start])
        newlines = src.count("\n", start, end)
        pieces.append("\n" * newlines if newlines else " ")
        pos = end
    pieces.append(src[pos:])
    return "".join(pieces)


# ---- normalize / fingerprint ----------------------------------------------------------------------------


def normalize_body(src: str) -> str:
    """Comments removed, whitespace collapsed to single spaces per line, blank lines dropped.

    Whitespace inside string and char literals is kept, so changing a literal still changes the result.
    Idempotent. Lines are kept (not joined) so `drift_report` can diff the result.
    """
    pieces: list[str] = []
    literals: list[str] = []
    pos = 0
    for start, end, kind in _scan(src):
        pieces.append(src[pos:start])
        if kind == "comment":
            pieces.append(" ")
        else:
            literals.append(src[start:end].replace("\r\n", "\n"))
            pieces.append(f"{_SENT_OPEN}{len(literals) - 1}{_SENT_CLOSE}")
        pos = end
    pieces.append(src[pos:])
    text = "".join(pieces).replace("\r\n", "\n").replace("\r", "\n")
    lines = (re.sub(r"\s+", " ", line).strip() for line in text.split("\n"))
    text = "\n".join(line for line in lines if line)
    return re.sub(f"{_SENT_OPEN}(\\d+){_SENT_CLOSE}", lambda m: literals[int(m.group(1))], text)


def fingerprint(body: str) -> str:
    """sha256 hex of the normalized body."""
    return hashlib.sha256(normalize_body(body).encode("utf-8")).hexdigest()


# ---- method extraction ------------------------------------------------------------------------------------

# A block opened by a type (or namespace) declaration. Anything else (method bodies, accessors, initializers)
# is "code"; a name is only a member declaration when its innermost enclosing block is a type body.
# `where T : class` does not match because the header must START with modifiers and then the keyword.
_TYPE_HEADER = re.compile(
    r"\s*(?:\[[^\]]*\]\s*)*"
    r"(?:(?:public|private|protected|internal|static|sealed|abstract|unsafe|partial|readonly|ref|new|file|record)\s+)*"
    r"(?:class|struct|interface|enum|record|namespace)\b"
)
_TYPE_PARAMS = re.compile(r"<[\w\s,]*>")
# Words that, right before a name, make it part of an expression (`new Foo(`, `return Foo(`) and not a declaration.
# A type keyword before the name means the type's own declaration (`struct Cargo`), not a constructor.
_NOT_A_DECLARATION_PREFIX = frozenset(
    "new return throw await yield in is as case else do goto typeof nameof sizeof default ref".split()
    + "class struct interface enum record namespace".split()
)
_BRACES = re.compile(r"[{}]")
_PARENS = re.compile(r"[()]")
_BLOCK_EVENTS = re.compile(r"[{};]")


@lru_cache(maxsize=16)
def _analyze(src: str) -> tuple[str, tuple[int, ...], tuple[bool, ...]]:
    """`(mask, positions, states)`: `src` with comments and literals blanked, and where the innermost block changes.

    After the brace at `positions[k]`, the innermost enclosing block is a type body iff `states[k]`.
    """
    mask = _blank(src, _scan(src))
    stack: list[bool] = []
    boundary = 0
    positions: list[int] = []
    states: list[bool] = []
    for match in _BLOCK_EVENTS.finditer(mask):
        p = match.start()
        char = match.group()
        if char == "{":
            stack.append(_TYPE_HEADER.match(mask, boundary, p) is not None)
        elif char == "}":
            if stack:
                stack.pop()
        boundary = p + 1
        if char != ";":
            positions.append(p)
            states.append(stack[-1] if stack else True)
    return mask, tuple(positions), tuple(states)


def _match_close(mask: str, start: int, pattern: re.Pattern[str], opener: str) -> int | None:
    """Index of the bracket closing the one at `start`, or None if it never closes."""
    depth = 0
    for match in pattern.finditer(mask, start):
        depth += 1 if match.group() == opener else -1
        if depth == 0:
            return match.start()
    return None


def _declaration_context(mask: str, p: int) -> bool:
    """Whether what precedes the name at `p` looks like a declaration (a type, modifier, attribute or boundary)."""
    j = p - 1
    while j >= 0 and mask[j].isspace():
        j -= 1
    if j < 0:
        return True
    c = mask[j]
    if c in ";{}]":
        return True
    if c == ">":  # `List<int> Foo(` yes; `=> Foo(` and `p->Foo(` no
        return not (j > 0 and mask[j - 1] in "=-")
    if c in "*?":  # `int* Foo(`, `int? Foo(` yes; `a * Foo(` no
        return j > 0 and (mask[j - 1].isalnum() or mask[j - 1] in "_>]")
    if c.isalnum() or c == "_":
        k = j
        while k >= 0 and (mask[k].isalnum() or mask[k] == "_"):
            k -= 1
        return mask[k + 1 : j + 1] not in _NOT_A_DECLARATION_PREFIX
    return False


def _expression_end(mask: str, k: int) -> int | None:
    """Index after the `;` ending an expression body that starts at `k`."""
    depth = 0
    for k in range(k, len(mask)):
        ch = mask[k]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                return None
        elif ch == ";" and depth == 0:
            return k + 1
    return None


def _after_signature(mask: str, k: int) -> int | None:
    """End of a member whose parameter list closed just before `k`: body block, `=> expr;` or a bare `;`."""
    depth = 0
    for k in range(k, len(mask)):
        ch = mask[k]
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
            if depth < 0:
                return None
        elif depth == 0:
            if ch == "{":
                close = _match_close(mask, k, _BRACES, "{")
                return None if close is None else close + 1
            if ch == ";":
                return k + 1
            if ch == "=" and mask.startswith("=>", k):
                return _expression_end(mask, k + 2)
    return None


def _member_end(mask: str, after_name: int) -> int | None:
    """End of the member whose name ends at `after_name`, or None when it is not a method or property."""
    n = len(mask)
    j = after_name
    while j < n and mask[j].isspace():
        j += 1
    generic = _TYPE_PARAMS.match(mask, j)
    if generic is not None:
        j = generic.end()
        while j < n and mask[j].isspace():
            j += 1
    if j >= n:
        return None
    if mask[j] == "(":
        close = _match_close(mask, j, _PARENS, "(")
        return None if close is None else _after_signature(mask, close + 1)
    if generic is None and mask[j] == "{":  # property: `Name { get { ... } }`
        close = _match_close(mask, j, _BRACES, "{")
        return None if close is None else close + 1
    if generic is None and mask.startswith("=>", j):  # expression-bodied property
        return _expression_end(mask, j + 2)
    return None


def _member_start(mask: str, p: int) -> int:
    """Start of the declaration containing the name at `p`: after the previous `;`, `{` or `}`, past blanks."""
    boundary = max(mask.rfind(";", 0, p), mask.rfind("{", 0, p), mask.rfind("}", 0, p))
    start = boundary + 1
    while start < p and mask[start].isspace():
        start += 1
    return start


def extract_method(source: str, method: str) -> str | None:
    """Every member of `source` named `method` (all overloads), from its attributes to its closing brace.

    The text is cut out by brace matching on a copy of the source in which comments, strings, chars and
    preprocessor lines are blanked, so braces and names inside them never count. Overloads are joined with a
    newline in source order. Handled: generic methods (`Foo<T>(...) where T : ...`), expression bodies
    (`=> expr;`), attributes, `unsafe` / `fixed`, abstract and interface declarations (ending in `;`), and
    properties with the same name (`Foo { ... }`, `Foo => expr;`). Calls are not declarations: a match must sit
    directly in a type body and follow a type, modifier or attribute, and the name must match whole
    (`InternalUpdateNoAnim` is not `InternalUpdate`). Nested types contribute their members too. Explicit
    interface implementations (`void IFoo.Bar()`) are not found. Returns None when nothing matches.
    """
    mask, positions, states = _analyze(source)
    name = re.compile(r"(?<![\w@.])" + re.escape(method) + r"(?!\w)")
    parts: list[str] = []
    last_end = 0
    for match in name.finditer(mask):
        p = match.start()
        if p < last_end:
            continue
        index = bisect_right(positions, p) - 1
        if index >= 0 and not states[index]:
            continue
        if not _declaration_context(mask, p):
            continue
        end = _member_end(mask, match.end())
        if end is None:
            continue
        parts.append(source[_member_start(mask, p) : end])
        last_end = end
    return "\n".join(parts) if parts else None


# ---- fingerprints and drift -----------------------------------------------------------------------------------


def build_fingerprints(
    game_version: str,
    sources: Mapping[str, str],
    mirrored: Mapping[str, str] | None = None,
    report: Report | None = None,
) -> dict:
    """The `data/fingerprints.json` document for the decompiled `sources` (type name -> C#).

    A mirrored method whose type was not decompiled, or that the type no longer has, is left out with a
    warning on `report`; `drift_report` then shows it as "missing" against an older file.
    """
    mirrored = MIRRORED if mirrored is None else mirrored
    methods: dict[str, dict[str, str]] = {}
    for key in sorted(mirrored):
        type_name, _, name = key.rpartition(".")
        source = sources.get(type_name)
        if source is None:
            if report is not None:
                report.warn(f"fingerprint {key}: type {type_name} was not decompiled", method=key)
            continue
        body = extract_method(source, name)
        if body is None:
            if report is not None:
                report.warn(f"fingerprint {key}: method {name} not found in {type_name}", method=key)
            continue
        methods[key] = {"sha256": fingerprint(body), "tsModule": mirrored[key]}
    return {"gameVersion": game_version, "methods": methods}


Status = Literal["changed", "missing", "new"]


@dataclass(frozen=True)
class DriftEntry:
    """One mirrored method whose game code changed (`changed`), vanished (`missing`) or appeared (`new`)."""

    method: str
    ts_module: str
    status: Status
    diff: str | None = None  # unified diff of the normalized bodies, when the previous source is available


def _methods_of(document: Mapping, label: str) -> Mapping[str, Mapping]:
    if not isinstance(document, Mapping):
        raise ExtractError(f"{label} fingerprints must be a JSON object")
    methods = document.get("methods", {})
    if not isinstance(methods, Mapping):
        raise ExtractError(f"{label} fingerprints: 'methods' must be an object")
    return methods


def _sha_of(methods: Mapping[str, Mapping], method: str, label: str) -> str | None:
    entry = methods.get(method)
    if entry is None:
        return None
    sha = entry.get("sha256") if isinstance(entry, Mapping) else None
    if not isinstance(sha, str):
        raise ExtractError(f"{label} fingerprints: {method} has no sha256")
    return sha


def _normalized_method(sources: Mapping[str, str] | None, method: str) -> str | None:
    if sources is None:
        return None
    type_name, _, name = method.rpartition(".")
    source = sources.get(type_name)
    body = None if source is None else extract_method(source, name)
    return None if body is None else normalize_body(body)


def _method_diff(
    method: str, status: Status, old_sources: Mapping[str, str] | None, new_sources: Mapping[str, str] | None
) -> str | None:
    old_body = _normalized_method(old_sources, method)
    if old_body is None:
        return None
    new_body = _normalized_method(new_sources, method)
    if new_body is None and status != "missing":
        return None
    old_lines = old_body.splitlines()
    new_lines = (new_body or "").splitlines()
    lines = difflib.unified_diff(
        old_lines, new_lines, fromfile=f"{method} (previous)", tofile=f"{method} (current)", lineterm=""
    )
    text = "\n".join(lines)
    return text or None


def drift_report(
    old: Mapping,
    new: Mapping,
    mirrored: Mapping[str, str],
    *,
    old_sources: Mapping[str, str] | None = None,
    new_sources: Mapping[str, str] | None = None,
) -> list[DriftEntry]:
    """Compare two fingerprint documents over the `mirrored` methods (sorted by method name).

    `old` and `new` have the `data/fingerprints.json` shape; `{}` is an empty file (everything in `new` is then
    "new"). Methods not in `mirrored` are ignored. With `old_sources` / `new_sources` (type name -> C#, e.g.
    `load_sources(local/decompiled.prev)` and the fresh decompile), changed and missing entries carry a unified
    diff of the normalized method bodies. A "new" entry never has one.
    """
    old_methods = _methods_of(old, "old")
    new_methods = _methods_of(new, "new")
    entries: list[DriftEntry] = []
    for method in sorted(mirrored):
        old_sha = _sha_of(old_methods, method, "old")
        new_sha = _sha_of(new_methods, method, "new")
        status: Status
        if old_sha is None and new_sha is None:
            continue
        if old_sha is None:
            status = "new"
        elif new_sha is None:
            status = "missing"
        elif old_sha != new_sha:
            status = "changed"
        else:
            continue
        diff = None if status == "new" else _method_diff(method, status, old_sources, new_sources)
        entries.append(DriftEntry(method, mirrored[method], status, diff))
    return entries
