"""Tests for the optional icon export."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from dsp_extract import icons
from dsp_extract.icons import IconCandidate, choose_candidate, export_icons, icon_name, wanted_icons
from dsp_extract.report import Report
from dsp_extract.steam import GameInstall


class FakeImage:
    """Stands in for a PIL image: `save(path, format=...)` writes recognisable bytes."""

    def __init__(self, label: str, fail: Exception | None = None) -> None:
        self.label = label
        self.fail = fail

    def save(self, path, format=None):  # noqa: A002 - PIL's parameter name
        if self.fail is not None:
            raise self.fail
        assert format == "PNG"
        Path(path).write_bytes(f"PNG:{self.label}".encode())


def candidate(name: str, size: int = 80, label: str | None = None, fail: Exception | None = None) -> IconCandidate:
    image = FakeImage(label or f"{name}@{size}", fail)
    return IconCandidate(name=name, width=size, height=size, image=lambda: image, source="resources.assets")


def make_install(tmp_path: Path) -> GameInstall:
    data = tmp_path / "game" / "DSPGAME_Data"
    data.mkdir(parents=True)
    return GameInstall(root=data.parent, data_dir=data, managed_dir=data / "Managed", build_id=None, library=None)


def items_with(*paths: str) -> list[dict]:
    return [{"id": 1000 + i, "iconPath": path} for i, path in enumerate(paths)]


# ---- names ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path, expected",
    [
        ("Icons/ItemRecipe/iron-ingot", "iron-ingot"),
        ("Icons\\ItemRecipe\\iron-ingot", "iron-ingot"),
        ("Icons/ItemRecipe/iron-ingot/", "iron-ingot"),
        ("iron-ingot", "iron-ingot"),
        ("", None),
        ("   ", None),
        ("Icons/ItemRecipe/", "ItemRecipe"),
        ("Icons/..", None),
        (None, None),
    ],
)
def test_icon_name_is_the_last_path_segment(path, expected):
    assert icon_name(path) == expected


def test_wanted_icons_groups_item_ids_by_icon_name_and_skips_items_without_icons():
    items = [
        {"id": 1, "iconPath": "Icons/ItemRecipe/a"},
        {"id": 2, "iconPath": "Icons/ItemRecipe/a"},
        {"id": 3, "iconPath": "Icons/ItemRecipe/b"},
        {"id": 4, "iconPath": ""},
        {"id": 5},
    ]
    assert wanted_icons(items) == {"a": [1, 2], "b": [3]}


# ---- choosing between textures of the same name -----------------------------------------------


def test_the_80_by_80_texture_is_preferred():
    chosen = choose_candidate([candidate("x", 256), candidate("x", 80), candidate("x", 40)])
    assert (chosen.width, chosen.height) == (80, 80)


def test_without_an_80_by_80_texture_the_closest_size_wins_larger_on_ties():
    assert choose_candidate([candidate("x", 256), candidate("x", 128)]).width == 128
    assert choose_candidate([candidate("x", 40), candidate("x", 120)]).width == 120  # both 40 away: the larger
    assert choose_candidate([candidate("x", 64)]).width == 64


# ---- export_icons -----------------------------------------------------------------------------


def run_export(tmp_path, items, found, report=None):
    report = report or Report()
    out = tmp_path / "icons"

    def candidates(install, names, rep):
        assert names == set(wanted_icons(items))
        return iter(found)

    count = export_icons(make_install(tmp_path), items, out, report, candidates=candidates)
    return count, out, report


def test_exports_one_png_per_wanted_icon_named_after_the_icon_path(tmp_path):
    items = items_with("Icons/ItemRecipe/iron-ingot", "Icons/ItemRecipe/copper-ingot")
    found = [candidate("iron-ingot"), candidate("copper-ingot"), candidate("unrelated")]
    count, out, report = run_export(tmp_path, items, found)
    assert count == 2
    assert sorted(p.name for p in out.iterdir()) == ["copper-ingot.png", "iron-ingot.png"]
    assert (out / "iron-ingot.png").read_bytes() == b"PNG:iron-ingot@80"
    assert report.warnings == []
    assert report.sections["icons"]["exported"] == 2 and report.sections["icons"]["wanted"] == 2


def test_the_80_pixel_texture_is_the_one_written(tmp_path):
    items = items_with("Icons/ItemRecipe/gear")
    count, out, _ = run_export(tmp_path, items, [candidate("gear", 256, "big"), candidate("gear", 80, "small")])
    assert count == 1
    assert (out / "gear.png").read_bytes() == b"PNG:small"


def test_missing_textures_are_one_aggregated_warning_not_a_failure(tmp_path):
    items = items_with(*[f"Icons/ItemRecipe/item-{i}" for i in range(30)])
    count, out, report = run_export(tmp_path, items, [candidate("item-0")])
    assert count == 1
    (warning,) = [w for w in report.warnings if "not found" in w]
    assert "29 of 30" in warning
    assert len(report.sections["icons"]["missing"]) == 29


def test_a_texture_that_cannot_be_saved_is_a_warning_and_the_rest_still_export(tmp_path):
    items = items_with("Icons/ItemRecipe/good", "Icons/ItemRecipe/bad")
    found = [candidate("bad", fail=ValueError("cannot decode ETC2")), candidate("good")]
    count, out, report = run_export(tmp_path, items, found)
    assert count == 1
    assert (out / "good.png").is_file() and not (out / "bad.png").exists()
    assert not list(out.glob("*.tmp"))
    assert any("bad" in w and "cannot decode ETC2" in w for w in report.warnings)
    assert report.sections["icons"]["failed"] == {"bad": "ValueError: cannot decode ETC2"}


def test_a_failing_texture_source_is_a_warning_only(tmp_path):
    def broken(install, names, report):
        raise RuntimeError("resources.assets is corrupt")

    report = Report()
    count = export_icons(make_install(tmp_path), items_with("Icons/ItemRecipe/a"), tmp_path / "icons", report, candidates=broken)
    assert count == 0
    assert any("resources.assets is corrupt" in w for w in report.warnings)


def test_textures_found_before_the_source_failed_are_still_written(tmp_path):
    def flaky(install, names, report):
        yield candidate("a")
        raise RuntimeError("sharedassets3.assets is corrupt")

    report = Report()
    out = tmp_path / "icons"
    count = export_icons(make_install(tmp_path), items_with("Icons/ItemRecipe/a"), out, report, candidates=flaky)
    assert count == 1 and (out / "a.png").is_file()
    assert any("sharedassets3.assets is corrupt" in w for w in report.warnings)


def test_nothing_wanted_is_a_warning(tmp_path):
    report = Report()
    assert export_icons(make_install(tmp_path), [{"id": 1, "iconPath": ""}], tmp_path / "icons", report, candidates=lambda *a: iter(())) == 0
    assert any("no item has an iconPath" in w for w in report.warnings)


def test_without_unitypy_the_export_warns_with_the_install_hint(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "UnityPy", None)  # `import UnityPy` raises ImportError
    report = Report()
    count = export_icons(make_install(tmp_path), items_with("Icons/ItemRecipe/a"), tmp_path / "icons", report)
    assert count == 0
    assert any("UnityPy" in w and "pip install" in w for w in report.warnings)


# ---- the UnityPy side, against a fake UnityPy -------------------------------------------------


class FakeTexture:
    def __init__(self, name, width, height, label=None, peek=True):
        self.m_Name, self.m_Width, self.m_Height = name, width, height
        self.image = FakeImage(label or f"{name}@{width}")
        self._peek = peek


class FakeReader:
    def __init__(self, kind, texture=None):
        self.type = SimpleNamespace(name=kind)
        self.texture = texture

    def peek_name(self):
        if self.texture is None:
            return None
        return self.texture.m_Name if self.texture._peek else None

    def read(self):
        if self.texture is None:
            raise AssertionError("only textures are read")
        return self.texture


class FakeLoadedFile:
    def __init__(self, readers):
        self.objects = dict(enumerate(readers, start=1))


def install_fake_unitypy(monkeypatch, files: dict[str, list[FakeReader]], broken=()):
    loaded_paths = []

    class Environment:
        def __init__(self, *args, path=None):
            self.path = path

        def load_file(self, file):
            loaded_paths.append(Path(file).name)
            name = Path(file).name
            if name in broken:
                raise OSError(f"cannot parse {name}")
            return FakeLoadedFile(files[name])

    module = types.ModuleType("UnityPy")
    module.Environment = Environment
    monkeypatch.setitem(sys.modules, "UnityPy", module)
    return loaded_paths


def test_unitypy_candidates_read_textures_from_resources_and_sharedassets(tmp_path, monkeypatch):
    install = make_install(tmp_path)
    for name in ("resources.assets", "sharedassets0.assets", "sharedassets1.assets"):
        (install.data_dir / name).write_bytes(b"")
    loaded = install_fake_unitypy(
        monkeypatch,
        {
            "resources.assets": [FakeReader("Texture2D", FakeTexture("iron-ingot", 80, 80)), FakeReader("Mesh")],
            "sharedassets0.assets": [
                FakeReader("Texture2D", FakeTexture("iron-ingot", 256, 256)),
                FakeReader("Texture2D", FakeTexture("unwanted", 80, 80)),
                FakeReader("Texture2D", FakeTexture("copper-ingot", 80, 80, peek=False)),  # name only via read()
            ],
            "sharedassets1.assets": [],
        },
    )
    report = Report()
    found = list(icons.unitypy_candidates(install, {"iron-ingot", "copper-ingot"}, report))
    assert loaded == ["resources.assets", "sharedassets0.assets", "sharedassets1.assets"]
    assert sorted((c.name, c.width) for c in found) == [("copper-ingot", 80), ("iron-ingot", 80), ("iron-ingot", 256)]
    assert report.warnings == []


def test_unitypy_candidates_end_to_end_through_export_icons(tmp_path, monkeypatch):
    install = make_install(tmp_path)
    (install.data_dir / "resources.assets").write_bytes(b"")
    install_fake_unitypy(
        monkeypatch,
        {"resources.assets": [FakeReader("Texture2D", FakeTexture("gear", 256, 256, "big")), FakeReader("Texture2D", FakeTexture("gear", 80, 80, "small"))]},
    )
    report = Report()
    out = tmp_path / "icons"
    assert export_icons(install, items_with("Icons/ItemRecipe/gear"), out, report) == 1
    assert (out / "gear.png").read_bytes() == b"PNG:small"


def test_a_data_file_that_fails_to_load_is_skipped_with_a_warning(tmp_path, monkeypatch):
    install = make_install(tmp_path)
    for name in ("resources.assets", "sharedassets0.assets"):
        (install.data_dir / name).write_bytes(b"")
    install_fake_unitypy(
        monkeypatch,
        {"resources.assets": [FakeReader("Texture2D", FakeTexture("a", 80, 80))], "sharedassets0.assets": []},
        broken=("sharedassets0.assets",),
    )
    report = Report()
    found = list(icons.unitypy_candidates(install, {"a"}, report))
    assert [c.name for c in found] == ["a"]
    assert any("sharedassets0.assets" in w and "cannot parse" in w for w in report.warnings)


def test_a_texture_that_fails_to_read_is_skipped_with_one_warning_per_file(tmp_path, monkeypatch):
    class Unreadable(FakeReader):
        def peek_name(self):
            return "a"

        def read(self):
            raise ValueError("bad texture header")

    install = make_install(tmp_path)
    (install.data_dir / "resources.assets").write_bytes(b"")
    install_fake_unitypy(
        monkeypatch,
        {"resources.assets": [Unreadable("Texture2D", FakeTexture("a", 80, 80)), Unreadable("Texture2D", FakeTexture("a", 80, 80))]},
    )
    report = Report()
    assert list(icons.unitypy_candidates(install, {"a"}, report)) == []
    warnings = [w for w in report.warnings if "bad texture header" in w]
    assert len(warnings) == 1 and "2" in warnings[0]


def test_names_with_path_separators_are_never_written(tmp_path):
    items = [{"id": 1, "iconPath": "Icons/ItemRecipe/ok"}]
    count, out, _ = run_export(tmp_path, items, [candidate("ok"), candidate("../evil")])
    assert count == 1
    assert not (tmp_path / "evil.png").exists()
