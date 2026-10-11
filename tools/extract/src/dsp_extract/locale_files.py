"""English strings from the game's `Locale/` folder (GX section 2.5).

Proto `Name` fields are Chinese keys; the English text lives in plain text files:
  <game root>/Locale/Header.txt      language list (`lcid,name,...`) and page order (`Page=N`)
  <game root>/Locale/1033/<page>.txt translations, one `key<TAB>?<TAB>?<TAB>text` line per key

The files are UTF-16 LE with a BOM in practice; a UTF-8 file (with or without BOM) also works.
Text escapes are `\\n \\t \\r \\\\`. `Header.txt` is read best-effort (its exact layout is not
verified): it only orders the pages and lets the report say whether English is listed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .errors import ExtractError
from .report import Report

ENGLISH_LCID = 1033
_KEY_CELLS = 4  # key, two unused cells, text
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\"}
_ESCAPE = re.compile(r"\\([ntr\\])")
_LANGUAGE = re.compile(r"^(\d{3,5})\s*[,;\t]\s*(.*)$")
_PAGE = re.compile(r"^([A-Za-z_][\w.\-]*)\s*=\s*(\d+)\s*$")


@dataclass
class Header:
    languages: list[tuple[int, str]] = field(default_factory=list)
    pages: list[str] = field(default_factory=list)  # page names in the header's numeric order


def unescape(text: str) -> str:
    """Resolve `\\n \\t \\r \\\\` in one pass; any other backslash sequence is left as written."""
    return _ESCAPE.sub(lambda m: _ESCAPES[m.group(1)], text)


def decode_text(data: bytes) -> str:
    """Decode a locale file: BOM-marked UTF-16/UTF-8, else UTF-16 LE if it holds NULs, else UTF-8."""
    if data.startswith(b"\xff\xfe"):
        return data[2:].decode("utf-16-le", errors="replace")
    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be", errors="replace")
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    if b"\x00" in data:  # UTF-8 text never contains NUL; mostly-ASCII UTF-16 always does
        return data.decode("utf-16-le", errors="replace")
    return data.decode("utf-8", errors="replace")


def parse_header(text: str) -> Header:
    header = Header()
    numbered: list[tuple[int, str]] = []
    for raw in text.split("\n"):
        line = raw.strip()
        language = _LANGUAGE.match(line)
        if language:
            header.languages.append((int(language.group(1)), language.group(2).split(",")[0].strip()))
            continue
        page = _PAGE.match(line)
        if page and page.group(1).lower() != "version":
            numbered.append((int(page.group(2)), page.group(1)))
    header.pages = [name for _, name in sorted(numbered, key=lambda p: p[0])]
    return header


def _child(parent: Path, name: str) -> Path | None:
    """`parent/name`, matched case-insensitively (the install may be read through Proton)."""
    direct = parent / name
    if direct.exists():
        return direct
    try:
        wanted = name.lower()
        for entry in parent.iterdir():
            if entry.name.lower() == wanted:
                return entry
    except OSError:
        pass
    return None


def _ordered_pages(files: list[Path], header: Header | None) -> list[Path]:
    by_stem = {f.stem.lower(): f for f in files}
    ordered: list[Path] = []
    for page in header.pages if header else []:
        match = by_stem.pop(page.lower(), None)
        if match is not None:
            ordered.append(match)
    ordered.extend(by_stem[stem] for stem in sorted(by_stem))
    return ordered


def _read_header(locale_dir: Path, report: Report | None) -> Header | None:
    path = _child(locale_dir, "Header.txt")
    if path is None:
        if report:
            report.warn(f"Locale header {locale_dir / 'Header.txt'} not found; loading pages in file-name order")
        return None
    try:
        header = parse_header(decode_text(path.read_bytes()))
    except OSError as exc:
        if report:
            report.warn(f"Cannot read {path}: {exc}; loading pages in file-name order")
        return None
    if report:
        report.info(
            f"Locale header: {len(header.languages)} languages, {len(header.pages)} pages",
            languages=[f"{lcid} {name}" for lcid, name in header.languages],
            pages=header.pages,
        )
        if header.languages and ENGLISH_LCID not in {lcid for lcid, _ in header.languages}:
            report.warn(f"Locale header lists no {ENGLISH_LCID} (English) language; reading Locale/{ENGLISH_LCID} anyway")
    return header


def load_english(game_root: Path, report: Report | None = None) -> dict[str, str]:
    """`key -> English text` for every `Locale/1033/*.txt` page; raises `ExtractError` if there are none."""
    root = Path(game_root)
    locale_dir = _child(root, "Locale")
    if locale_dir is None or not locale_dir.is_dir():
        raise ExtractError(f"Locale folder not found: {root / 'Locale'} (the game's English strings live there)")
    english_dir = _child(locale_dir, str(ENGLISH_LCID))
    if english_dir is None or not english_dir.is_dir():
        raise ExtractError(f"English locale folder not found: {locale_dir / str(ENGLISH_LCID)}")
    pages = [p for p in english_dir.iterdir() if p.is_file() and p.suffix.lower() == ".txt"]
    if not pages:
        raise ExtractError(f"English locale folder {english_dir} has no .txt files")

    header = _read_header(locale_dir, report)
    strings: dict[str, str] = {}
    conflicts: list[str] = []
    for page in _ordered_pages(pages, header):
        malformed: list[tuple[int, str]] = []
        for number, line in enumerate(decode_text(page.read_bytes()).split("\n"), start=1):
            line = line.rstrip("\r")
            if not line.strip():
                continue
            cells = line.split("\t", _KEY_CELLS - 1)
            if len(cells) < _KEY_CELLS or not cells[0]:
                malformed.append((number, line))
                continue
            key, text = cells[0], unescape(cells[_KEY_CELLS - 1])
            if key in strings and strings[key] != text:
                conflicts.append(key)
            strings[key] = text
        if malformed and report:
            first = ", ".join(f"line {n}: {text[:60]!r}" for n, text in malformed[:3])
            report.warn(
                f"{page.name}: skipped {len(malformed)} malformed locale lines "
                f"(expected 'key<TAB>?<TAB>?<TAB>text'), first: {first}"
            )
    if report:
        if conflicts:
            report.warn(
                f"{len(conflicts)} locale keys appear in several pages with different text "
                f"(later pages win), first: {conflicts[0]!r}"
            )
        report.info(f"Locale: {len(strings)} English strings from {len(pages)} files in {english_dir}")
        report.set("locale", {"directory": str(english_dir), "files": len(pages), "strings": len(strings)})
    return strings
