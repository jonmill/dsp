"""`dsp-extract` command line: the end-to-end extraction, plus `inspect` and `fixture`.

    dsp-extract [--game-dir PATH] [--out DIR] [--copy-blueprints] [--icons] [--no-decompile]
                [--check] [--strict] [--allow-partial] [--report PATH]
    dsp-extract inspect [--game-dir PATH] [--report PATH]
    dsp-extract fixture --from DIR --out FILE

The default flow is locate the game -> decompile (ilspycmd, optional) -> read the Unity assets -> code
constants -> fingerprints and drift -> normalize -> validate against the JSON Schema -> atomic write ->
optional icons and blueprints -> summary. The first run against a real install is the first time the game
reader meets real data, so every outcome writes the JSON report (`local/extract-report.json`): findings,
warnings and errors, and the traceback of an unexpected failure. Exit codes are listed in `EXIT_CODES_HELP`.
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import sys
import traceback
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Any

from . import __version__, fixture
from .code_constants import parse_constants
from .decompile import (
    TYPES_TO_DECOMPILE,
    DriftEntry,
    build_fingerprints,
    decompile_types,
    drift_report,
    find_ilspycmd,
    load_sources,
    rotate_previous,
)
from .errors import ExtractError
from .icons import export_icons
from .mirrored_methods import MIRRORED
from .normalize import NormalizeError, normalize
from .prefab import describe_prefab
from .raw import RawBundle
from .report import Report
from .schema_check import SchemaError, validate_against_schema
from .steam import GameInstall, GameNotFoundError, locate_game
from .unity_reader import UnityEnvAdapter, check_game_dependencies, find_protosets, read_bundle
from .writer import dumps_json, write_atomic

EXIT_OK = 0
EXIT_GAME_NOT_FOUND = 2
EXIT_EXTRACT_ERROR = 3
EXIT_SCHEMA_ERROR = 4
EXIT_DRIFT = 5
EXIT_INTERRUPTED = 130

EXIT_CODES_HELP = """\
exit codes:
  0  GameData written (some buildings may use approximate geometry; the summary says how many)
  2  Dyson Sphere Program not found (also what argparse uses for a command line usage error)
  3  extraction failed and no GameData written (including too many unreadable buildings, see --allow-partial, or any
     unreadable belt, sorter, logistics station, spray coater, production building or lab, which --allow-partial does not allow);
     also --strict with report errors, or a crash after the data was written
  4  the extracted GameData failed schema validation, nothing written
  5  --check and a mirrored game method changed or went missing

Every run writes local/extract-report.json (or --report PATH); send it back when something fails.
"""

SCHEMA_RELATIVE = Path("data") / "schema" / "gamedata.schema.json"
FINGERPRINTS_FILE = "fingerprints.json"
ACCEPTED_MARKER = ".accepted"  # in local/decompiled: that decompile's run wrote its GameData and fingerprints
PARTIAL_LIMIT = 0.25  # more unreadable buildings than this share of all buildings: no GameData without --allow-partial
# The buildings the planner cannot do without, by item id (stable across game versions): the belts, sorters and logistics stations
# every layout is made of, the spray coater every proliferated layout has, and every building that runs a recipe (smelters,
# assemblers, refineries, chemical plants, colliders, labs).
# A building whose prefab could not be read has no descriptors, so GameData would have it as kind 'other' and the planner could not
# use it: an unreadable one of these is fatal whatever its share of all buildings, and --allow-partial does not allow it.
CORE_BUILDING_ITEMS: dict[int, str] = {
    **{item_id: "belt" for item_id in (2001, 2002, 2003)},
    **{item_id: "sorter" for item_id in (2011, 2012, 2013, 2014)},
    **{item_id: "station" for item_id in (2103, 2104)},
    **{item_id: "production building" for item_id in (2302, 2303, 2304, 2305, 2308, 2309, 2310, 2315, 2317, 2318, 2319)},
    **{item_id: "lab" for item_id in (2901, 2902)},
    2313: "spray coater",
}
MAX_FAILED_LISTED = 10
MAX_DIFF_LINES = 30  # per drift entry on the terminal; the report keeps the whole diff
MAX_APPROXIMATE_LISTED = 10

# `inspect`: the prefab walks. (label, item id, name hint). The item id gives the ModelProto and so the prefab
# path; the hint searches the model prefab paths when the id is unknown to this game version.
INSPECT_SAMPLES = (
    ("assembler-mk-1", 2303, "assembler-mk-1"),
    ("logistic-station", 2103, "logistic-station"),
    ("inserter-1", 2011, "inserter-1"),
    ("belt-1", 2001, "belt-1"),
    ("tesla tower", 2201, "tesla"),
)
INSPECT_ENTRIES = 3


class RepoNotFoundError(Exception):
    """The repository root (the folder holding data/schema/gamedata.schema.json) cannot be found."""


class PartialDataError(ExtractError):
    """Too many buildings could not be read from their prefab for the GameData to be trusted."""


def find_repo_root(start: Path | None = None, package_file: Path | None = None) -> Path:
    """The repository root: walk up from `start` (the cwd) to a folder with `data/schema/gamedata.schema.json`.

    When the cwd is not inside the repository the walk is repeated from this package's own location, so the
    command works from anywhere once it is installed in editable mode from the repository.
    """
    origins = [Path.cwd() if start is None else Path(start), (Path(__file__) if package_file is None else Path(package_file)).parent]
    for origin in origins:
        origin = origin.resolve()
        for folder in (origin, *origin.parents):
            if (folder / SCHEMA_RELATIVE).is_file():
                return folder
    raise RepoNotFoundError(
        f"cannot find {SCHEMA_RELATIVE.as_posix()} above {origins[0]} or above the dsp_extract package at {origins[1]}. "
        "Run dsp-extract from inside the repository checkout."
    )


@dataclass(frozen=True)
class RepoPaths:
    root: Path

    @property
    def schema(self) -> Path:
        return self.root / SCHEMA_RELATIVE

    @property
    def data(self) -> Path:
        return self.root / "data"

    @property
    def local(self) -> Path:
        return self.root / "local"

    @property
    def icons(self) -> Path:
        return self.root / "app" / "public" / "icons"

    @property
    def blueprints(self) -> Path:
        return self.root / "app" / "test" / "fixtures" / "blueprints" / "game"


# ---- output helpers ---------------------------------------------------------------------------


def say(message: str) -> None:
    """Progress on stderr, flushed, so a slow step is visibly in progress."""
    print(f"dsp-extract: {message}", file=sys.stderr, flush=True)


def plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _file_safe(text: str) -> str:
    return re.sub(r"[^0-9A-Za-z._+-]", "_", text)


def _package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except Exception:
        return None


def _environment(argv: Sequence[str]) -> dict[str, Any]:
    return {
        "dsp_extract": __version__,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cwd": str(Path.cwd()),
        "argv": list(argv),
        "UnityPy": _package_version("UnityPy"),
        "TypeTreeGeneratorAPI": _package_version("TypeTreeGeneratorAPI"),
        "jsonschema": _package_version("jsonschema"),
    }


def _make_streams_safe() -> None:
    """Never let an unencodable character (the game's Chinese item keys) crash a print after the work is done."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError, OSError):
            pass


def open_adapter(install: GameInstall, report: Report) -> Any:
    """The UnityPy adapter for `inspect` (a seam for tests)."""
    return UnityEnvAdapter.open(install, report)


# ---- the command wrapper: report in every outcome ---------------------------------------------


@dataclass
class Failure:
    message: str
    show_summary: bool = True
    unexpected: bool = False


Body = Callable[[argparse.Namespace, Report, RepoPaths, Path], int]


def _run_command(args: argparse.Namespace, argv: Sequence[str], body: Body) -> int:
    """Run `body`, map what it raises to an exit code, and always write the report."""
    report = Report()
    report.set("environment", _environment(argv))
    explicit = getattr(args, "report", None)
    report_path = Path(explicit).expanduser() if explicit else Path("local") / "extract-report.json"
    paths: RepoPaths | None = None
    code = EXIT_OK
    failure: Failure | None = None
    try:
        try:
            paths = RepoPaths(find_repo_root())
        except RepoNotFoundError as exc:
            report.error(str(exc))
            code, failure = EXIT_EXTRACT_ERROR, Failure(f"dsp-extract: {exc}", show_summary=False)
        else:
            if not explicit:
                report_path = paths.local / "extract-report.json"
            code = body(args, report, paths, report_path)
    except GameNotFoundError as exc:
        report.error(f"game not found: {exc}")
        code, failure = EXIT_GAME_NOT_FOUND, Failure(f"dsp-extract: {exc}", show_summary=False)
    except SchemaError as exc:
        report.error(f"schema validation failed: {exc}")
        code, failure = EXIT_SCHEMA_ERROR, Failure(f"dsp-extract: {exc}")
    except (ExtractError, NormalizeError) as exc:
        report.error(f"{type(exc).__name__}: {exc}")
        code, failure = EXIT_EXTRACT_ERROR, Failure(f"dsp-extract: extraction failed: {exc}")
    except KeyboardInterrupt:
        report.error("interrupted by the user (Ctrl-C)")
        code, failure = EXIT_INTERRUPTED, Failure("dsp-extract: interrupted", show_summary=False)
    except Exception as exc:
        trace = traceback.format_exc()
        report.error(f"unexpected {type(exc).__name__}: {exc}", traceback=trace)
        report.set("traceback", trace)
        code = EXIT_EXTRACT_ERROR
        failure = Failure(f"dsp-extract: unexpected error ({type(exc).__name__}: {exc})", unexpected=True)

    written = _write_report(report, report_path)
    if failure is not None:
        _print_failure(failure, report, report_path if written else None, wrote_data=report.get("output") is not None)
    return code


def _write_report(report: Report, path: Path) -> bool:
    try:
        report.write(path)
        return True
    except Exception as exc:
        print(f"dsp-extract: could not write the report to {path}: {exc}", file=sys.stderr)
        return False


def _print_failure(failure: Failure, report: Report, report_path: Path | None, *, wrote_data: bool) -> None:
    err = sys.stderr
    if failure.show_summary and not failure.unexpected:
        print(report.summary(), file=err)
    print(failure.message, file=err)
    if report_path is None:
        # Nowhere to put the diagnosis, so the terminal gets it.
        trace = report.get("traceback")
        if failure.unexpected and trace:
            print(trace, file=err)
        return
    if failure.unexpected:
        print(
            "This is probably a bug in the extractor or an unsupported game version. The full traceback is in the "
            f"report: {report_path}\nPlease send that file back.",
            file=err,
        )
    else:
        if not wrote_data and failure.show_summary:
            print("No GameData was written.", file=err)
        print(f"Details: {report_path} (send it back if the cause is not clear from the message above)", file=err)


# ---- extraction -------------------------------------------------------------------------------


def _decompile(install: GameInstall, paths: RepoPaths, report: Report) -> tuple[dict[str, str], dict[str, str]]:
    """`(sources, previous_sources)`; `sources` is empty when ilspycmd is missing or fails (a report warning)."""
    ilspy = find_ilspycmd()
    if ilspy is None:
        report.warn(
            "ilspycmd was not found on PATH or in ~/.dotnet/tools, so the game is not decompiled: the game version "
            "comes from the Steam build id, the code constants keep their unverified defaults and the fingerprints "
            "are not updated. Install it with: dotnet tool install -g ilspycmd"
        )
        return {}, {}
    out_dir = paths.local / "decompiled"
    if (out_dir / ACCEPTED_MARKER).is_file() and any(out_dir.glob("*.cs")):
        # The last decompile was accepted (its GameData and fingerprints were written): it becomes the baseline.
        rotate_previous(out_dir)
    elif any(out_dir.glob("*.cs")):
        # It comes from a run that failed or was only checked, so decompiled.prev still holds the accepted baseline
        # and must not be replaced by it (the next diff would compare the new code with itself).
        report.info("local/decompiled is from a run that was not accepted; keeping local/decompiled.prev as the baseline")
    previous = load_sources(out_dir.with_name(out_dir.name + ".prev"))
    say(f"decompiling {len(TYPES_TO_DECOMPILE)} game types with {ilspy} (a few minutes) ...")
    try:
        written = decompile_types(ilspy, install.managed_dir, TYPES_TO_DECOMPILE, out_dir, report)
    except ExtractError as exc:
        report.warn(
            f"decompilation failed ({exc}); continuing without decompiled sources: game version from the Steam "
            "build id, default code constants, fingerprints not updated"
        )
        return {}, previous
    sources = {name: text for name, text in load_sources(out_dir).items() if name in written}
    return sources, previous


@dataclass
class FingerprintPlan:
    path: Path
    document: dict | None  # what to write; None when there is nothing to write
    drift: list[DriftEntry]
    note: str  # for the summary when it is not written


def _read_fingerprints(path: Path) -> tuple[dict, str]:
    """`(document, problem)`; a missing file is an empty document, an unusable one has a `problem`."""
    if not path.is_file():
        return {}, ""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {}, f"cannot read it: {exc}"
    if not isinstance(document, dict):
        return {}, "it is not a JSON object"
    return document, ""


def _merge_fingerprints(old: dict, new: dict, sources: dict[str, str]) -> dict:
    """`new`, plus the committed entries of mirrored methods whose type was not decompiled this time."""
    methods = dict(new.get("methods", {}))
    old_methods = old.get("methods", {})
    if isinstance(old_methods, dict):
        for key, entry in old_methods.items():
            if key in MIRRORED and key not in methods and key.rpartition(".")[0] not in sources:
                methods[key] = entry
    return {"gameVersion": new["gameVersion"], "methods": methods}


def _plan_fingerprints(
    bundle_version: str, sources: dict[str, str], previous: dict[str, str], data_dir: Path, report: Report
) -> FingerprintPlan:
    path = data_dir / FINGERPRINTS_FILE
    if not sources:
        return FingerprintPlan(path, None, [], "not written (nothing was decompiled)")
    old, problem = _read_fingerprints(path)
    if problem:
        report.warn(f"{path} {problem}; drift is not checked and the file is left untouched")
        return FingerprintPlan(path, None, [], f"left untouched ({problem})")
    new = build_fingerprints(bundle_version, sources, MIRRORED, report)
    # A mirrored type that did not decompile is not drift ("missing"); only compare what was decompiled.
    comparable = {key: module for key, module in MIRRORED.items() if key.rpartition(".")[0] in sources}
    try:
        drift = drift_report(old, new, comparable, old_sources=previous or None, new_sources=sources)
    except ExtractError as exc:
        report.warn(f"{path}: {exc}; drift is not checked and the file is left untouched")
        return FingerprintPlan(path, None, [], f"left untouched ({exc})")
    merged = _merge_fingerprints(old, new, sources)
    if not merged["methods"]:
        report.warn("no mirrored game method could be fingerprinted from the decompiled sources; the file is left untouched")
        return FingerprintPlan(path, None, drift, "left untouched (no mirrored method found)")
    return FingerprintPlan(path, merged, drift, "")


def _record_drift(drift: list[DriftEntry], report: Report) -> None:
    report.set(
        "drift", [{"method": e.method, "status": e.status, "ts_module": e.ts_module, "diff": e.diff} for e in drift]
    )
    for entry in drift:
        if entry.status == "new":
            report.info(f"mirrored game method {entry.method} has no fingerprint yet", method=entry.method)
        else:
            report.warn(
                f"mirrored game method {entry.method} {entry.status}; re-check {entry.ts_module}", method=entry.method
            )


def _drift_lines(drift: list[DriftEntry]) -> list[str]:
    counts = Counter(e.status for e in drift)
    lines = [f"Drift: {counts['changed']} changed, {counts['missing']} missing, {counts['new']} new (mirrored game methods)"]
    for entry in drift:
        lines.append(f"  {entry.status:<7} {entry.method} -> {entry.ts_module}")
        if entry.diff:
            diff = entry.diff.splitlines()
            lines.extend(f"      {line}" for line in diff[:MAX_DIFF_LINES])
            if len(diff) > MAX_DIFF_LINES:
                lines.append(f"      ... {len(diff) - MAX_DIFF_LINES} more diff lines (see drift in the report)")
    return lines


def _unreadable_buildings(report: Report) -> list[tuple[str, dict]]:
    """`(item id, record)` of buildings whose prefab or core descriptors could not be read (written as kind 'other')."""
    records = report.get("per_building_geometry") or {}
    return [(i, r) for i, r in records.items() if r.get("unreadable") or r.get("status") == "failed"]


def _building_label(item_id: str, record: dict, locale: dict[str, str]) -> str:
    key = record.get("name_key") or "?"
    return f"{locale.get(key, key)} ({item_id})"


def _core_item(item_id: str) -> str | None:
    """What the planner needs the building for (`CORE_BUILDING_ITEMS`), or None if it is not a building it cannot do without."""
    try:
        return CORE_BUILDING_ITEMS.get(int(item_id))
    except ValueError:
        return None


def _guard_partial_data(bundle: RawBundle, report: Report, *, allow_partial: bool) -> None:
    """
    Refuse to go on when a core building (`CORE_BUILDING_ITEMS`) could not be read, whatever the share and whether or not
    `allow_partial`, or when more than `PARTIAL_LIMIT` of the buildings could not be read, unless `allow_partial`.
    """
    bad = _unreadable_buildings(report)
    core = [(item_id, record) for item_id, record in bad if _core_item(item_id) is not None]
    if core:
        listed = []
        for item_id, record in core[:MAX_FAILED_LISTED]:
            problems = record.get("problems") or []
            reason = f": {problems[0][:200]}" if problems else ""
            listed.append(f"  - {_building_label(item_id, record, bundle.locale)} ({_core_item(item_id)}){reason}")
        if len(core) > MAX_FAILED_LISTED:
            listed.append(f"  ... and {len(core) - MAX_FAILED_LISTED} more (per_building_geometry in the report lists them all)")
        raise PartialDataError(
            f"{len(core)} {'building' if len(core) == 1 else 'buildings'} the planner cannot do without could not be read from "
            "their game prefab (belts, sorters, logistics stations and the buildings that run recipes are needed whole; "
            "this is fatal whatever share of all buildings it is, and --allow-partial does not allow it):\n"
            + "\n".join(listed)
            + "\nFix the cause (see the report)."
        )
    total = len(bundle.buildings)
    if not bad or total == 0 or len(bad) / total <= PARTIAL_LIMIT:
        return
    share = f"{len(bad)} of {total} buildings ({100 * len(bad) // total}%)"
    if allow_partial:
        report.warn(
            f"--allow-partial: {share} could not be read from their game prefab and are written anyway, as kind "
            "'other' with no descriptors and approximate geometry"
        )
        return
    listed = []
    for item_id, record in bad[:MAX_FAILED_LISTED]:
        problems = record.get("problems") or []
        reason = f": {problems[0][:200]}" if problems else ""
        listed.append(f"  - {_building_label(item_id, record, bundle.locale)}{reason}")
    if len(bad) > MAX_FAILED_LISTED:
        listed.append(f"  ... and {len(bad) - MAX_FAILED_LISTED} more (per_building_geometry in the report lists them all)")
    raise PartialDataError(
        f"{share} could not be read from their game prefab (the limit is {int(PARTIAL_LIMIT * 100)}%), so the "
        "GameData would be mostly wrong:\n"
        + "\n".join(listed)
        + "\nFix the cause (see the report), or pass --allow-partial to write the data anyway; those buildings "
        "would get kind 'other', no descriptors and approximate geometry."
    )


def _mark_accepted(paths: RepoPaths, game_version: str, report: Report) -> None:
    try:
        (paths.local / "decompiled" / ACCEPTED_MARKER).write_text(f"{game_version}\n", encoding="utf-8")
    except OSError as exc:
        report.warn(f"cannot mark local/decompiled as accepted ({exc}); the next diff may compare against this decompile")


def _copy_blueprints(install: GameInstall, dest: Path, report: Report) -> int:
    try:
        source = install.compatdata_blueprint_dir()
        if source is None:
            report.warn(
                "--copy-blueprints: no Proton blueprint folder found (it needs the game inside a Steam library with "
                "compatdata/1366540/pfx/.../Documents/Dyson Sphere Program/Blueprint); copy the .txt files by hand"
            )
            return 0
        files = sorted(p for p in source.rglob("*.txt") if p.is_file())
        for file in files:
            target = dest / file.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
        report.info(f"copied {len(files)} blueprints from {source} to {dest}")
        return len(files)
    except Exception as exc:
        report.warn(f"--copy-blueprints failed: {type(exc).__name__}: {exc}")
        return 0


def run_extract(args: argparse.Namespace, report: Report, paths: RepoPaths, report_path: Path) -> int:
    say("looking for Dyson Sphere Program ...")
    install = locate_game(args.game_dir, Path.home(), sys.platform)
    report.set(
        "install",
        {
            "root": str(install.root),
            "data_dir": str(install.data_dir),
            "steam_build_id": install.build_id,
            "library": None if install.library is None else str(install.library),
        },
    )
    say(f"found {install.root}")
    check_game_dependencies()  # before the multi-minute decompile: UnityPy and TypeTreeGeneratorAPI must be there
    out_dir = Path(args.out).expanduser() if args.out else paths.data

    sources: dict[str, str] = {}
    previous: dict[str, str] = {}
    if args.no_decompile:
        report.info("--no-decompile: ilspycmd was not run")
    else:
        sources, previous = _decompile(install, paths, report)

    say("reading the Unity assets (this can take a minute) ...")
    bundle = read_bundle(install, report, decompiled=sources or None)
    report.set("game_version", bundle.game_version)
    _guard_partial_data(bundle, report, allow_partial=args.allow_partial)

    values, origins = parse_constants(sources, report)
    bundle.constants.update(values)
    bundle.constant_sources.update(origins)
    report.set("code_constants", {"read_from_game_code": origins})

    plan = _plan_fingerprints(bundle.game_version, sources, previous, paths.data, report)
    _record_drift(plan.drift, report)

    say("normalizing and validating ...")
    data = normalize(bundle, __version__, _now())
    validate_against_schema(data, paths.schema)

    target = out_dir / f"dsp-{_file_safe(bundle.game_version)}.json"
    write_atomic(target, data)
    report.set(
        "output",
        {
            "path": str(target),
            "game_version": bundle.game_version,
            "items": len(data["items"]),
            "recipes": len(data["recipes"]),
            "techs": len(data["techs"]),
            "buildings": len(data["buildings"]),
        },
    )
    say(f"wrote {target}")

    fingerprint_note = plan.note
    accepted = False  # the repo now holds this run's GameData and fingerprints: its decompile is the next baseline
    if plan.document is not None:
        old, _ = _read_fingerprints(plan.path)
        if plan.document == old:
            fingerprint_note = f"up to date ({len(plan.document['methods'])} methods)"
            accepted = True
        elif args.check:
            fingerprint_note = "not written (--check never accepts new hashes)"
        else:
            write_atomic(plan.path, plan.document, dumps=dumps_json)
            fingerprint_note = f"written ({len(plan.document['methods'])} methods)"
            accepted = True
    if accepted and sources:
        _mark_accepted(paths, bundle.game_version, report)

    icons_exported = None
    if args.icons:
        say("exporting icons ...")
        try:
            icons_exported = export_icons(install, data["items"], paths.icons, report)
        except Exception as exc:
            report.warn(f"icon export failed: {type(exc).__name__}: {exc}")
    blueprints_copied = _copy_blueprints(install, paths.blueprints, report) if args.copy_blueprints else None

    return _finish(args, report, report_path, data, plan, fingerprint_note, target, icons_exported, blueprints_copied, paths)


def _finish(
    args: argparse.Namespace,
    report: Report,
    report_path: Path,
    data: dict,
    plan: FingerprintPlan,
    fingerprint_note: str,
    target: Path,
    icons_exported: int | None,
    blueprints_copied: int | None,
    paths: RepoPaths,
) -> int:
    print(report.summary())
    print()
    meta = data["meta"]
    geometry = Counter(b["geometry"]["source"] for b in data["buildings"])
    approximate = [b for b in data["buildings"] if b["geometry"]["source"] != "extracted"]
    errors, warnings = len(report.errors), len(report.warnings)

    lines = ["== dsp-extract result =="]
    build = f", Steam build {meta['steamBuildId']}" if "steamBuildId" in meta else ""
    from_build_id = meta["gameVersion"].startswith("0.0.0+build")
    note = " (no GameConfig version: this is the Steam build id; decompile with ilspycmd for the real one)" if from_build_id else ""
    lines.append(f"Game version: {meta['gameVersion']}{build}{note}")
    lines.append(
        f"Wrote {target} ({len(data['items'])} items, {len(data['recipes'])} recipes, "
        f"{len(data['techs'])} techs, {len(data['buildings'])} buildings)"
    )
    lines.append(f"Building geometry: {geometry['extracted']} extracted, {geometry['approximate']} approximate")
    if approximate:
        names = ", ".join(f"{b['name']} ({b['itemId']})" for b in approximate[:MAX_APPROXIMATE_LISTED])
        more = f", and {len(approximate) - MAX_APPROXIMATE_LISTED} more" if len(approximate) > MAX_APPROXIMATE_LISTED else ""
        lines.append(f"  approximate: {names}{more} (details per building in the report)")
    failed = _unreadable_buildings(report)
    if failed:
        names = ", ".join(_building_label(i, r, {}) for i, r in failed[:MAX_APPROXIMATE_LISTED])
        lines.append(
            f"WARNING: {plural(len(failed), 'building')} could not be read from the game prefab and "
            f"{'was' if len(failed) == 1 else 'were'} written with kind 'other', no descriptors and approximate geometry: "
            f"{names} (use --strict to make this fatal)"
        )
    read = report.get("code_constants", {}).get("read_from_game_code", {})
    lines.append(f"Code constants read from the game: {', '.join(sorted(read)) if read else 'none (defaults kept)'}")
    lines.append(f"Fingerprints ({plan.path}): {fingerprint_note or 'checked'}")
    lines.extend(_drift_lines(plan.drift) if plan.document is not None or plan.drift else [])
    if icons_exported is not None:
        lines.append(f"Icons: {icons_exported} exported to {paths.icons}")
    if blueprints_copied is not None:
        lines.append(f"Blueprints: {blueprints_copied} copied to {paths.blueprints}")
    lines.append(f"Report: {plural(errors, 'error')}, {plural(warnings, 'warning')} -> {report_path}")
    print("\n".join(lines))

    if args.strict and errors:
        print(
            f"dsp-extract: --strict: the report has {plural(errors, 'error')}; GameData was written but the exit status is 3.",
            file=sys.stderr,
        )
        return EXIT_EXTRACT_ERROR
    if args.check and plan.document is None and not plan.drift:
        message = f"--check could not compare the mirrored game methods: fingerprints {fingerprint_note}"
        report.warn(message)
        print(f"dsp-extract: {message}", file=sys.stderr)
    blocking = [e for e in plan.drift if e.status in ("changed", "missing")]
    if args.check and blocking:
        print(
            f"dsp-extract: --check: {plural(len(blocking), 'mirrored game method')} changed or went missing "
            "(listed above); re-check the TypeScript modules named there.",
            file=sys.stderr,
        )
        return EXIT_DRIFT
    return EXIT_OK


# ---- inspect ----------------------------------------------------------------------------------


def _first_entries(tree: dict) -> list | None:
    rows = tree.get("dataArray")
    return rows[:INSPECT_ENTRIES] if isinstance(rows, list) else None


def _entry_label(entry: Any) -> str:
    if isinstance(entry, dict):
        return f"{entry.get('ID', '?')}:{entry.get('Name', '')}"
    return str(entry)


def _prefab_walks(adapter: Any, items: list[dict], models: list[dict], report: Report) -> dict[str, dict]:
    items_by_id = {int(i["ID"]): i for i in items if isinstance(i, dict) and "ID" in i}
    models_by_id = {int(m["ID"]): m for m in models if isinstance(m, dict) and "ID" in m}
    walks: dict[str, dict] = {}
    for label, item_id, hint in INSPECT_SAMPLES:
        walk: dict[str, Any] = {"item_id": item_id}
        walks[label] = walk
        try:
            item = items_by_id.get(item_id)
            model = models_by_id.get(int(item["ModelIndex"])) if item is not None and item.get("ModelIndex") else None
            if model is not None:
                walk["resolved_by"] = f"item {item_id}"
            else:
                matches = sorted(m for m in models_by_id.values() if hint in str(m.get("PrefabPath", "")).lower())
                model = matches[0] if matches else None
                walk["resolved_by"] = f"prefab path containing {hint!r}"
            if model is None or not model.get("PrefabPath"):
                raise LookupError(f"item {item_id} is not in this game and no model prefab path contains {hint!r}")
            walk.update(describe_prefab(adapter, str(model["PrefabPath"])))
        except Exception as exc:
            walk["error"] = f"{type(exc).__name__}: {exc}"
            sample = getattr(exc, "sample", None)
            if sample and report.get("container_sample") is None:
                report.set("container_sample", sample)
    return walks


def run_inspect(args: argparse.Namespace, report: Report, paths: RepoPaths, report_path: Path) -> int:
    say("looking for Dyson Sphere Program ...")
    install = locate_game(args.game_dir, Path.home(), sys.platform)
    say(f"found {install.root}")
    check_game_dependencies()
    say("loading the Unity assets (this can take a minute) ...")
    adapter = open_adapter(install, report)
    found = find_protosets(adapter, report)

    listing: dict[str, dict] = {}
    samples: dict[str, dict] = {}
    rows: dict[str, list] = {}
    for class_name, objs in sorted(found.items()):
        entry: dict[str, Any] = {"count": len(objs), "read": False}
        listing[class_name] = entry
        try:
            tree = adapter.read_typetree(objs[0])
            data_array = tree.get("dataArray")
            entry.update(
                table_name=tree.get("TableName"),
                signature=tree.get("Signature"),
                entries=len(data_array) if isinstance(data_array, list) else None,
                read=True,
            )
            samples[class_name] = {"keys": sorted(tree), "first_entries": _first_entries(tree)}
            if isinstance(data_array, list):
                rows[class_name] = data_array
        except Exception as exc:
            samples[class_name] = {"error": f"{type(exc).__name__}: {exc}"}
    report.set("protosets_found", listing)
    report.set("protoset_samples", samples)
    walks = _prefab_walks(adapter, rows.get("ItemProtoSet", []), rows.get("ModelProtoSet", []), report)
    report.set("prefab_walks", walks)

    lines = [f"Unity version: {report.get('unity_version') or 'unknown'}"]
    for record in report.get("files_loaded") or []:
        detail = f"error: {record['error']}" if record.get("error") else f"{record.get('objects', '?')} objects"
        lines.append(f"  {record.get('name')}: {detail}")
    lines.append(f"ProtoSet classes found: {len(listing)}")
    for class_name, entry in listing.items():
        first = samples[class_name].get("first_entries")
        head = ", ".join(_entry_label(e) for e in first) if first else samples[class_name].get("error", "no dataArray")
        lines.append(f"  {class_name}: {entry.get('entries', '?')} entries; first: {head}")
    lines.append("Sample prefabs:")
    for label, walk in walks.items():
        if "error" in walk:
            lines.append(f"  {label}: {walk['error']}")
        else:
            scripts = sorted({c for g in walk["game_objects"] for c in g["components"] if c.startswith("MonoBehaviour:")})
            lines.append(
                f"  {label}: {walk['prefab_path']} -> {len(walk['game_objects'])} GameObjects; "
                f"scripts: {', '.join(s.split(':', 1)[1] for s in scripts) or 'none'}"
            )
    lines.append(f"Full detail (no GameData written): {report_path}")
    print("\n".join(lines))
    return EXIT_OK


# ---- argument parsing -------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dsp-extract",
        description="Extract Dyson Sphere Program data into the planner's GameData JSON. "
        "Without a subcommand, runs the full extraction.",
        epilog=EXIT_CODES_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--game-dir", type=Path, metavar="PATH", help="the Dyson Sphere Program folder (or its DSPGAME_Data folder); default: find it through Steam")
    parser.add_argument("--out", type=Path, metavar="DIR", help="output folder for dsp-<gameVersion>.json (default: <repo>/data); data/fingerprints.json always stays in the repo")
    parser.add_argument("--copy-blueprints", action="store_true", help="copy your .txt blueprints from the Proton prefix to app/test/fixtures/blueprints/game/")
    parser.add_argument("--icons", action="store_true", help="export item icons as PNG to app/public/icons/ (needs the game extra)")
    parser.add_argument("--no-decompile", action="store_true", help="do not run ilspycmd (game version from the Steam build id, default code constants, fingerprints untouched)")
    parser.add_argument("--check", action="store_true", help="exit 5 if a mirrored game method changed or went missing; does not rewrite fingerprints.json")
    parser.add_argument("--strict", action="store_true", help="exit 3 after writing if the report has errors (for example buildings that fell back from a failed prefab read)")
    parser.add_argument("--allow-partial", action="store_true", help="write the GameData even if more than 25%% of the buildings could not be read from their prefab (otherwise exit 3 and write nothing)")
    parser.add_argument("--report", type=Path, metavar="PATH", help="where to write the JSON report (default: <repo>/local/extract-report.json)")

    sub = parser.add_subparsers(dest="command", metavar="{inspect,fixture}")

    ins = sub.add_parser(
        "inspect",
        help="list the asset files, ProtoSet classes and sample prefabs into the report; writes no GameData",
        description="Diagnostic run: lists the Unity data files, the Unity version, every ProtoSet class found with its "
        "first 3 entries, and a prefab walk of 5 sample buildings, all into the report. No GameData is written.",
    )
    ins.add_argument("--game-dir", type=Path, metavar="PATH", default=argparse.SUPPRESS, help="the Dyson Sphere Program folder")
    ins.add_argument("--report", type=Path, metavar="PATH", default=argparse.SUPPRESS, help="where to write the JSON report")
    ins.set_defaults(body=run_inspect)

    fx = sub.add_parser("fixture", help="build the fixture GameData from a dsp-parser dump")
    fx.add_argument("--from", dest="src", type=Path, required=True, metavar="DIR", help="dsp-parser data directory")
    fx.add_argument("--out", dest="fixture_out", type=Path, required=True, metavar="FILE", help="output GameData JSON path")
    fx.set_defaults(handler=lambda args: fixture.run(args.src, args.fixture_out))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    _make_streams_safe()
    arguments = list(sys.argv[1:] if argv is None else argv)
    args = build_parser().parse_args(arguments)
    handler = getattr(args, "handler", None)
    if handler is not None:
        return handler(args)
    body = getattr(args, "body", None) or run_extract
    return _run_command(args, arguments, body)


if __name__ == "__main__":
    raise SystemExit(main())
