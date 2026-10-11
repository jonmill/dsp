"""Export item icons as PNG files (optional, `dsp-extract --icons`; the output folder is gitignored).

Item icons are `Texture2D` objects in `resources.assets` (or a `sharedassets*.assets`), named by the last
segment of the item's `iconPath` (`Icons/ItemRecipe/iron-ingot` -> texture `iron-ingot`, GX section 5). The same
name can exist at several resolutions; the 80x80 one is preferred (what soarqin's `generate_icons.py` uses).
Everything here is best effort: any failure is a report warning and never stops the extraction.

Texture names are read without decoding the pixel data (`ObjectReader.peek_name`), and only the textures that
some item asks for are fully read. Decoding the image needs Pillow, which UnityPy depends on.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .report import Report
from .steam import GameInstall
from .unity_reader import INSTALL_HINT

__all__ = ["IconCandidate", "choose_candidate", "export_icons", "icon_name", "unitypy_candidates", "wanted_icons"]

PREFERRED_SIZE = 80
MAX_LISTED = 50  # missing / failed icons listed in the report section


@dataclass(frozen=True)
class IconCandidate:
    """One Texture2D that carries a wanted name. `image()` decodes it to a PIL image when called."""

    name: str
    width: int
    height: int
    image: Callable[[], Any]
    source: str  # the asset file it came from, for diagnostics


def icon_name(icon_path: object) -> str | None:
    """The texture name for an `iconPath`: its last non-empty segment, or None when there is no usable name."""
    if not isinstance(icon_path, str):
        return None
    segments = [s for s in icon_path.replace("\\", "/").split("/") if s.strip()]
    if not segments:
        return None
    name = segments[-1].strip()
    if name in (".", "..") or "\0" in name:
        return None
    return name


def wanted_icons(items: Iterable[Mapping]) -> dict[str, list[int]]:
    """Texture name -> ids of the items using it (items without an `iconPath` are left out)."""
    wanted: dict[str, list[int]] = {}
    for item in items:
        name = icon_name(item.get("iconPath"))
        if name is not None:
            wanted.setdefault(name, []).append(item.get("id"))
    return wanted


def choose_candidate(candidates: list[IconCandidate]) -> IconCandidate:
    """The 80x80 texture if there is one, else the size closest to 80 (the larger one on a tie)."""
    return min(candidates, key=lambda c: (abs(c.width - PREFERRED_SIZE) + abs(c.height - PREFERRED_SIZE), -c.width))


def unitypy_candidates(install: GameInstall, names: set[str], report: Report) -> Iterator[IconCandidate]:
    """Every `Texture2D` named in `names` from `resources.assets` and the `sharedassets*.assets` files.

    A file that cannot be loaded is a warning and skipped; textures that fail to read are counted in one
    warning per file. A missing UnityPy raises ImportError (the caller reports it).
    """
    import UnityPy  # lazy on purpose: the `game` extra is optional

    data_dir = install.data_dir
    env = UnityPy.Environment(path=str(data_dir))
    files = ["resources.assets", *sorted(p.name for p in data_dir.glob("sharedassets*.assets"))]
    for file_name in files:
        path = data_dir / file_name
        if not path.is_file():
            continue
        try:
            loaded = env.load_file(str(path))
            if loaded is None:
                raise OSError("UnityPy could not open the file")
        except Exception as exc:
            report.warn(f"icons: {file_name} could not be loaded and is skipped: {exc}")
            continue
        failed = 0
        first_error = ""
        for obj in loaded.objects.values():
            if obj.type.name != "Texture2D":
                continue
            try:
                texture = None
                name = obj.peek_name()
                if name is None:
                    texture = obj.read()
                    name = texture.m_Name
                if name not in names:
                    continue
                if texture is None:
                    texture = obj.read()
                yield IconCandidate(
                    name=name,
                    width=int(texture.m_Width),
                    height=int(texture.m_Height),
                    image=lambda texture=texture: texture.image,
                    source=file_name,
                )
            except Exception as exc:
                failed += 1
                first_error = first_error or f"{type(exc).__name__}: {exc}"
        if failed:
            report.warn(f"icons: {failed} textures in {file_name} could not be read, first: {first_error}")


def _save_png(image: Any, target: Path) -> None:
    tmp = target.with_name(target.name + ".tmp")
    try:
        image.save(tmp, format="PNG")
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def export_icons(
    install: GameInstall,
    items: Iterable[Mapping],
    out_dir: Path,
    report: Report,
    *,
    candidates: Callable[[GameInstall, set[str], Report], Iterable[IconCandidate]] = unitypy_candidates,
) -> int:
    """Write `<out_dir>/<iconName>.png` for every item icon found; returns how many were written.

    `items` are GameData items (`id`, `iconPath`). Never raises: whatever cannot be read, decoded or saved is
    a warning, and the `icons` section of the report lists what is missing or failed.
    """
    wanted = wanted_icons(items)
    summary: dict[str, Any] = {"wanted": len(wanted), "exported": 0, "missing": [], "failed": {}, "out_dir": str(out_dir)}
    report.set("icons", summary)
    if not wanted:
        report.warn("icons: no item has an iconPath, so there is nothing to export")
        return 0

    found: dict[str, list[IconCandidate]] = {}
    try:
        for texture in candidates(install, set(wanted), report):
            found.setdefault(texture.name, []).append(texture)
    except Exception as exc:
        reason = f"UnityPy is not installed: {INSTALL_HINT}" if isinstance(exc, ImportError) else f"{type(exc).__name__}: {exc}"
        report.warn(f"icons: cannot read the textures completely ({reason})")

    out_dir = Path(out_dir)
    exported = 0
    missing: list[str] = []
    failed: dict[str, str] = {}
    for name in sorted(wanted):
        options = found.get(name)
        if not options:
            missing.append(name)
            continue
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            _save_png(choose_candidate(options).image(), out_dir / f"{name}.png")
            exported += 1
        except Exception as exc:
            failed[name] = f"{type(exc).__name__}: {exc}"
            report.warn(f"icons: cannot export {name}: {failed[name]}", icon=name)

    summary.update(exported=exported, missing=missing[:MAX_LISTED], failed=dict(list(failed.items())[:MAX_LISTED]))
    if missing:
        report.warn(
            f"icons: {len(missing)} of {len(wanted)} icons were not found as Texture2D objects "
            f"(first: {', '.join(missing[:5])})"
        )
    report.info(f"icons: exported {exported} of {len(wanted)} to {out_dir}")
    return exported
