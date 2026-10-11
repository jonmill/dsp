import pytest

from dsp_extract import vdf

LIBRARYFOLDERS = """\
"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"/home/user/.local/share/Steam"
\t\t"label"\t\t""
\t\t"contentid"\t\t"4857112209846550931"
\t\t"totalsize"\t\t"0"
\t\t"update_clean_bytes_tally"\t\t"8341902"
\t\t"time_last_update_corruption"\t\t"0"
\t\t"apps"
\t\t{
\t\t\t"228980"\t\t"412345678"
\t\t\t"1493710"\t\t"98765432"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"/mnt/games/SteamLibrary"
\t\t"label"\t\t"games"
\t\t"contentid"\t\t"1122334455667788990"
\t\t"totalsize"\t\t"1000204886016"
\t\t"update_clean_bytes_tally"\t\t"55501234"
\t\t"time_last_update_corruption"\t\t"0"
\t\t"apps"
\t\t{
\t\t\t"1366540"\t\t"123"
\t\t}
\t}
}
"""

APPMANIFEST = """\
"AppState"
{
\t"appid"\t\t"1366540"
\t"Universe"\t\t"1"
\t"name"\t\t"Dyson Sphere Program"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"Dyson Sphere Program"
\t"LastUpdated"\t\t"1760000000"
\t"SizeOnDisk"\t\t"3500000000"
\t"buildid"\t\t"20345678"
\t"InstalledDepots"
\t{
\t\t"1366541"
\t\t{
\t\t\t"manifest"\t\t"7000000000000000001"
\t\t\t"size"\t\t"3500000000"
\t\t}
\t}
\t"UserConfig"
\t{
\t\t"language"\t\t"english"
\t}
}
"""


def test_parse_libraryfolders_two_libraries():
    data = vdf.parse(LIBRARYFOLDERS)
    folders = data["libraryfolders"]
    assert set(folders) == {"0", "1"}
    assert folders["0"]["path"] == "/home/user/.local/share/Steam"
    assert folders["0"]["label"] == ""
    assert folders["0"]["apps"] == {"228980": "412345678", "1493710": "98765432"}
    assert folders["1"]["path"] == "/mnt/games/SteamLibrary"
    assert folders["1"]["apps"] == {"1366540": "123"}


def test_parse_appmanifest():
    state = vdf.parse(APPMANIFEST)["AppState"]
    assert state["installdir"] == "Dyson Sphere Program"
    assert state["buildid"] == "20345678"
    assert state["InstalledDepots"]["1366541"]["size"] == "3500000000"


def test_escaped_quote_inside_value():
    data = vdf.parse(r'"k" { "name" "The \"Big\" One" }')
    assert data["k"]["name"] == 'The "Big" One'


def test_escaped_backslash_and_other_escapes():
    data = vdf.parse(r'"k" { "path" "C:\\Program Files (x86)\\Steam" "t" "a\tb\nc" }')
    assert data["k"]["path"] == "C:\\Program Files (x86)\\Steam"
    assert data["k"]["t"] == "a\tb\nc"


def test_unknown_escape_is_kept_literally():
    # Hand-edited files sometimes carry a lone backslash; do not lose it.
    assert vdf.parse(r'"k" { "p" "C:\Steam" }')["k"]["p"] == "C:\\Steam"


def test_line_comments_are_ignored():
    text = """\
// header comment
"root" // trailing comment
{
\t"a" "1" // value comment
\t// full line comment
\t"b" "http://not-a-comment"
}
"""
    data = vdf.parse(text)
    assert data == {"root": {"a": "1", "b": "http://not-a-comment"}}


def test_empty_block_and_empty_input():
    assert vdf.parse('"root" { "empty" { } }') == {"root": {"empty": {}}}
    assert vdf.parse("") == {}
    assert vdf.parse("  \n// only a comment\n") == {}


def test_crlf_and_bom():
    text = '\ufeff"root"\r\n{\r\n\t"a"\t"1"\r\n}\r\n'
    assert vdf.parse(text) == {"root": {"a": "1"}}


def test_braces_inside_quoted_strings_are_text():
    assert vdf.parse('"root" { "a" "{" "b" "}" }') == {"root": {"a": "{", "b": "}"}}


def test_unquoted_tokens():
    assert vdf.parse("root { a 1 }") == {"root": {"a": "1"}}


def test_multiple_top_level_keys():
    assert vdf.parse('"a" "1" "b" { "c" "2" }') == {"a": "1", "b": {"c": "2"}}


def test_duplicate_key_last_wins():
    assert vdf.parse('"r" { "a" "1" "a" "2" }') == {"r": {"a": "2"}}


@pytest.mark.parametrize(
    "text",
    [
        '"root" { "a" "unterminated }',
        '"root" { "a" "1"',
        '"root" "a" "1" }',
        '"root" { "a" }',
        '"root"',
    ],
)
def test_malformed_input_raises(text):
    with pytest.raises(vdf.VdfError):
        vdf.parse(text)


def test_error_mentions_line():
    with pytest.raises(vdf.VdfError, match="line 3"):
        vdf.parse('"root"\n{\n"a" "oops\n}')
