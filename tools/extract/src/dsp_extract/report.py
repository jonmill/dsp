"""Diagnostic report for a game extraction.

The extractor cannot be run against a real install in CI, so the first real run on the user's
machine has to say exactly what to fix. A `Report` collects leveled log entries plus structured
sections, writes them as JSON (`local/extract-report.json`) and prints a short human summary.

Sections (keys of `Report.sections`, all JSON-serializable):
  unity_version           the Unity version string of the loaded asset files
  files_loaded            one record per asset file: name, size, object count, error if it failed
  protosets_found         ProtoSet class -> {count, table_name, signature, entries, read}
  per_building_geometry   item id -> what was read for that building and what fell back
  collider_layers_seen    every distinct (layer, is_trigger, GameObject name, shape) with the usage
                          decided for it, so the collider-usage rule (research gap 1) can be fixed
  (other keys may be added by the readers, for example typetree_generator or container; the CLI adds
   environment, install, game_version, decompile, code_constants, drift, output, icons, container_sample,
   protoset_samples, prefab_walks and, after an unexpected failure, traceback)
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO

DEFAULT_REPORT_PATH = Path("local") / "extract-report.json"
REPORT_VERSION = 1
SUMMARY_ENTRIES = 25  # entries per level shown in the human summary; the JSON has them all


@dataclass
class Entry:
    level: str  # "info" | "warn" | "error"
    message: str
    context: dict[str, Any] = field(default_factory=dict)


class Report:
    def __init__(self) -> None:
        self.created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.entries: list[Entry] = []
        self.sections: dict[str, Any] = {
            "unity_version": None,
            "files_loaded": [],
            "protosets_found": {},
            "per_building_geometry": {},
            "collider_layers_seen": [],
        }
        self._layers: dict[tuple, dict[str, Any]] = {}

    # ---- log entries --------------------------------------------------------------------------

    def _add(self, level: str, message: str, context: dict[str, Any]) -> None:
        self.entries.append(Entry(level, message, context))

    def info(self, message: str, **context: Any) -> None:
        self._add("info", message, context)

    def warn(self, message: str, **context: Any) -> None:
        self._add("warn", message, context)

    def error(self, message: str, **context: Any) -> None:
        self._add("error", message, context)

    def _messages(self, level: str) -> list[str]:
        return [e.message for e in self.entries if e.level == level]

    @property
    def infos(self) -> list[str]:
        return self._messages("info")

    @property
    def warnings(self) -> list[str]:
        return self._messages("warn")

    @property
    def errors(self) -> list[str]:
        return self._messages("error")

    @property
    def has_errors(self) -> bool:
        return any(e.level == "error" for e in self.entries)

    # ---- sections -----------------------------------------------------------------------------

    def set(self, name: str, value: Any) -> None:
        self.sections[name] = value

    def get(self, name: str, default: Any = None) -> Any:
        return self.sections.get(name, default)

    def set_building(self, item_id: int, record: dict[str, Any]) -> None:
        self.sections["per_building_geometry"][str(item_id)] = record

    def note_collider(
        self,
        *,
        layer: int,
        layer_name: str | None,
        is_trigger: bool,
        name: str,
        shape: str,
        usage: str,
        item_id: int | None = None,
    ) -> None:
        """Record one collider's (layer, trigger, GameObject name, shape) and the usage chosen for it."""
        key = (layer, is_trigger, name, shape)
        row = self._layers.get(key)
        if row is None:
            row = {
                "layer": layer,
                "layer_name": layer_name,
                "is_trigger": is_trigger,
                "name": name,
                "shape": shape,
                "usage": usage,
                "count": 0,
                "example_items": [],
            }
            self._layers[key] = row
            self.sections["collider_layers_seen"].append(row)
        row["count"] += 1
        if item_id is not None and item_id not in row["example_items"] and len(row["example_items"]) < 5:
            row["example_items"].append(item_id)

    # ---- output -------------------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        counts = {level: sum(1 for e in self.entries if e.level == level) for level in ("info", "warn", "error")}
        return {
            "report_version": REPORT_VERSION,
            "created_at": self.created_at,
            "counts": counts,
            **self.sections,
            "entries": [asdict(e) for e in self.entries],
        }

    def write(self, path: Path = DEFAULT_REPORT_PATH) -> Path:
        """Write the full report as JSON (creating parent folders) and return the path."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(self.to_dict(), indent=2, ensure_ascii=False, default=str)
        path.write_text(text + "\n", encoding="utf-8")
        return path

    def summary(self) -> str:
        sections = self.sections
        lines = ["== dsp-extract report =="]
        lines.append(f"Unity version: {sections.get('unity_version') or 'unknown'}")

        files = sections.get("files_loaded") or []
        loaded = [f for f in files if not f.get("error")]
        lines.append(f"Files loaded: {len(loaded)} of {len(files)}")
        for f in files:
            detail = f"error: {f['error']}" if f.get("error") else f"{f.get('objects', '?')} objects"
            lines.append(f"  {f.get('name')}: {detail}")

        found = sections.get("protosets_found") or {}
        lines.append(f"ProtoSets found: {len(found)}")
        for cls, info in found.items():
            lines.append(f"  {cls}: {info.get('entries', '?')} entries, signature {info.get('signature') or '?'}")

        buildings = sections.get("per_building_geometry") or {}
        if buildings:
            tally: dict[str, int] = {}
            for record in buildings.values():
                tally[record.get("status", "?")] = tally.get(record.get("status", "?"), 0) + 1
            parts = ", ".join(f"{n} {status}" for status, n in sorted(tally.items()))
            lines.append(f"Buildings: {len(buildings)} ({parts})")
            degraded = [(i, r) for i, r in buildings.items() if r.get("status") != "extracted"]
            for item_id, record in degraded[:SUMMARY_ENTRIES]:
                lines.append(f"  {item_id} {record.get('name_key') or ''}: {record.get('status')}")
            if len(degraded) > SUMMARY_ENTRIES:
                lines.append(f"  ... and {len(degraded) - SUMMARY_ENTRIES} more (see the JSON report)")

        layers = sections.get("collider_layers_seen") or []
        if layers:
            lines.append(f"Collider layers seen: {len(layers)} distinct (layer, trigger, name, shape)")
            for row in layers:
                label = f"layer {row['layer']}" + (f" '{row['layer_name']}'" if row.get("layer_name") else "")
                lines.append(
                    f"  {label}, trigger={row['is_trigger']}, name={row['name']!r}, {row['shape']} "
                    f"-> {row['usage']} (x{row['count']})"
                )

        for level, title in (("error", "Errors"), ("warn", "Warnings")):
            entries = [e for e in self.entries if e.level == level]
            lines.append(f"{title}: {len(entries)}")
            for e in entries[:SUMMARY_ENTRIES]:
                lines.append(f"  - {e.message}")
            if len(entries) > SUMMARY_ENTRIES:
                lines.append(f"  ... and {len(entries) - SUMMARY_ENTRIES} more (see the JSON report)")
        return "\n".join(lines)

    def print_summary(self, stream: TextIO | None = None) -> None:
        print(self.summary(), file=stream if stream is not None else sys.stdout)
