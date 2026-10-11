from pathlib import Path

import pytest

from dsp_extract.errors import ExtractError
from dsp_extract.locale_files import load_english, unescape
from dsp_extract.report import Report

HEADER = "Version=1.0\r\n1033,English,EN,en,0\r\n2052,Chinese,CN,zh,0\r\nItem=1\r\nRecipe=2\r\n"


def write_utf16(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfe" + text.encode("utf-16-le"))


def make_locale(root: Path, files: dict[str, str], header: str | None = HEADER) -> Path:
    """`root/Locale/Header.txt` plus UTF-16-LE-with-BOM `root/Locale/1033/<name>.txt` files."""
    if header is not None:
        write_utf16(root / "Locale" / "Header.txt", header)
    for name, text in files.items():
        write_utf16(root / "Locale" / "1033" / f"{name}.txt", text)
    return root


def test_utf16_with_bom_maps_chinese_key_to_english(tmp_path):
    make_locale(tmp_path, {"Item": "处理器\t0\t0\tProcessor\r\n铁块\t1\t0\tIron Ingot\r\n"})
    locale = load_english(tmp_path)
    assert locale["处理器"] == "Processor"
    assert locale["铁块"] == "Iron Ingot"


def test_escapes_are_unescaped_in_one_pass(tmp_path):
    text = "k1\t0\t0\tline1\\nline2\r\nk2\t0\t0\ta\\tb\r\nk3\t0\t0\tc\\rd\r\nk4\t0\t0\tback\\\\slash\r\nk5\t0\t0\tliteral\\\\n\r\n"
    make_locale(tmp_path, {"Item": text})
    locale = load_english(tmp_path)
    assert locale["k1"] == "line1\nline2"
    assert locale["k2"] == "a\tb"
    assert locale["k3"] == "c\rd"
    assert locale["k4"] == "back\\slash"
    # `\\n` is an escaped backslash followed by `n`, not backslash + newline.
    assert locale["k5"] == "literal\\n"


def test_unescape_leaves_unknown_escapes_alone():
    assert unescape("a\\qb") == "a\\qb"
    assert unescape("tail\\") == "tail\\"


def test_utf8_without_bom_works(tmp_path):
    (tmp_path / "Locale" / "1033").mkdir(parents=True)
    (tmp_path / "Locale" / "1033" / "Item.txt").write_bytes("处理器\t0\t0\tProcessor\n".encode("utf-8"))
    assert load_english(tmp_path)["处理器"] == "Processor"


def test_utf8_with_bom_works(tmp_path):
    (tmp_path / "Locale" / "1033").mkdir(parents=True)
    (tmp_path / "Locale" / "1033" / "Item.txt").write_bytes(b"\xef\xbb\xbf" + "处理器\t0\t0\tProcessor\n".encode("utf-8"))
    assert load_english(tmp_path)["处理器"] == "Processor"


def test_header_is_optional(tmp_path):
    make_locale(tmp_path, {"Item": "a\t0\t0\tA\n"}, header=None)
    assert load_english(tmp_path) == {"a": "A"}


def test_files_are_merged_in_header_page_order_and_later_pages_win(tmp_path):
    # Header lists Item before Recipe; alphabetical order would put "Recipe" after "Item" too, so
    # name them to make header order differ from alphabetical order.
    header = "Version=1\n1033,English,EN,en,0\nZeta=1\nAlpha=2\n"
    make_locale(tmp_path, {"Alpha": "k\t0\t0\tfrom alpha\n", "Zeta": "k\t0\t0\tfrom zeta\nonly\t0\t0\tz\n"}, header=header)
    locale = load_english(tmp_path)
    assert locale["k"] == "from alpha"
    assert locale["only"] == "z"


def test_unlisted_pages_are_still_loaded(tmp_path):
    make_locale(tmp_path, {"Item": "a\t0\t0\tA\n", "Extra": "b\t0\t0\tB\n"})
    assert load_english(tmp_path) == {"a": "A", "b": "B"}


def test_text_cell_keeps_extra_tabs_and_unicode_line_separators(tmp_path):
    make_locale(tmp_path, {"Item": "k\t0\t0\tone\ttwo still one line\nk2\t0\t0\tv\n"})
    locale = load_english(tmp_path)
    assert locale["k"] == "one\ttwo still one line"
    assert locale["k2"] == "v"


def test_blank_and_short_lines_are_skipped_and_reported(tmp_path):
    make_locale(tmp_path, {"Item": "\r\nbroken line\r\nkey\t0\t0\tvalue\r\n\t0\t0\tno key\r\n"})
    report = Report()
    locale = load_english(tmp_path, report)
    assert locale == {"key": "value"}
    assert any("malformed" in w and "Item.txt" in w for w in report.warnings)


def test_missing_locale_folder_raises(tmp_path):
    with pytest.raises(ExtractError, match="Locale"):
        load_english(tmp_path)


def test_missing_english_folder_raises(tmp_path):
    write_utf16(tmp_path / "Locale" / "Header.txt", HEADER)
    (tmp_path / "Locale" / "2052").mkdir()
    with pytest.raises(ExtractError, match="1033"):
        load_english(tmp_path)


def test_empty_english_folder_raises(tmp_path):
    (tmp_path / "Locale" / "1033").mkdir(parents=True)
    with pytest.raises(ExtractError, match="no .*txt"):
        load_english(tmp_path)


def test_folder_names_match_case_insensitively(tmp_path):
    write_utf16(tmp_path / "locale" / "1033" / "item.TXT", "a\t0\t0\tA\n")
    assert load_english(tmp_path) == {"a": "A"}


def test_header_without_english_warns_but_still_loads(tmp_path):
    make_locale(tmp_path, {"Item": "a\t0\t0\tA\n"}, header="Version=1\n2052,Chinese,CN,zh,0\n")
    report = Report()
    assert load_english(tmp_path, report) == {"a": "A"}
    assert any("1033" in w for w in report.warnings)


def test_decode_text_guesses_bomless_utf16_and_survives_garbage():
    from dsp_extract.locale_files import decode_text

    assert decode_text("处理器\t0\t0\tProcessor".encode("utf-16-le")) == "处理器\t0\t0\tProcessor"
    assert decode_text(b"\xff\xfe" + "x".encode("utf-16-le")) == "x"
    assert decode_text(b"\xfe\xff" + "y".encode("utf-16-be")) == "y"
    assert "�" in decode_text(b"ok \xe9 bad utf8")  # replaced, not raised


def test_parse_header_orders_pages_by_number_and_ignores_unknown_lines():
    from dsp_extract.locale_files import parse_header

    header = parse_header("Version=1.0.2\n1033,English,en\n2052,Chinese,zh\nRecipe=5\nItem=2\nsomething else\n")
    assert header.languages == [(1033, "English"), (2052, "Chinese")]
    assert header.pages == ["Item", "Recipe"]
