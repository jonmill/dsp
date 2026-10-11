"""The whole command, and the icon export, against UnityPy's real parser over the synthetic game (unity_synth).

Skipped unless UnityPy is installed. Nothing is faked except what the game DLLs would supply (the type tree
generator, see test_unity_real.py) and the Steam lookup. ilspycmd is never run (`--no-decompile`).
"""

from __future__ import annotations

import json

import pytest

pytest.importorskip("UnityPy")

import unity_synth
from test_cli import REAL_REPO, repo  # noqa: F401  (a fixture)
from test_unity_real import install  # noqa: F401  (a fixture)

from dsp_extract import cli
from dsp_extract.icons import export_icons
from dsp_extract.report import Report
from dsp_extract.schema_check import validate_against_schema

SCHEMA = REAL_REPO / "data" / "schema" / "gamedata.schema.json"


def load_report(repo_root):
    return json.loads((repo_root / "local" / "extract-report.json").read_text(encoding="utf-8"))


def test_the_full_extraction_over_real_unitypy_writes_valid_game_data(repo, install, monkeypatch, capsys):  # noqa: F811
    monkeypatch.setattr(cli, "locate_game", lambda *a: install)

    assert cli.main(["--no-decompile"]) == 0

    out = repo / "data" / "dsp-0.0.0+build20345678.json"  # no decompile: the version is the Steam build id
    data = json.loads(out.read_text(encoding="utf-8"))
    validate_against_schema(data, SCHEMA)
    (assembler,) = [b for b in data["buildings"] if b["itemId"] == 2303]
    assert assembler["geometry"]["source"] == "extracted"
    assert assembler["production"] == {"recipeType": "ASSEMBLE", "speed": 7500}
    assert data["meta"]["protoSignatures"]["ItemProtoSet"] == unity_synth.SIGNATURES["Item"]

    report = load_report(repo)
    assert report["unity_version"] == "2022.3.62f3c1"
    assert report["per_building_geometry"]["2303"]["status"] == "extracted"
    assert report["output"]["buildings"] == 1
    assert report["environment"]["UnityPy"]
    summary = capsys.readouterr().out
    assert "1 extracted, 0 approximate" in summary


def test_inspect_over_real_unitypy_lists_the_protosets_and_walks_the_sample_prefab(repo, install, monkeypatch, capsys):  # noqa: F811
    monkeypatch.setattr(cli, "locate_game", lambda *a: install)

    assert cli.main(["inspect"]) == 0

    report = load_report(repo)
    assert {"ItemProtoSet", "RecipeProtoSet", "TechProtoSet", "ModelProtoSet"} <= set(report["protoset_samples"])
    first = report["protoset_samples"]["ItemProtoSet"]["first_entries"]
    assert [e["ID"] for e in first] == [1101, 2303]
    walk = report["prefab_walks"]["assembler-mk-1"]
    assert walk["container_key"] == "entities/prefabs/assembler-mk-1"
    assert [g["path"] for g in walk["game_objects"]][0] == "assembler-mk-1"
    assert "error" in report["prefab_walks"]["tesla tower"]  # not in the synthetic game
    assert not any(p.name.startswith("dsp-") for p in (repo / "data").iterdir())
    assert "ItemProtoSet" in capsys.readouterr().out


# ---- icons: real Texture2D objects -----------------------------------------------------------------


def texture_value(name: str, width: int, height: int, rgba: tuple[int, int, int, int]) -> dict:
    pixels = bytes(rgba) * (width * height)
    return {
        "m_Name": name,
        "m_ForcedFallbackFormat": 4,
        "m_DownscaleFallback": False,
        "m_IsAlphaChannelOptional": False,
        "m_Width": width,
        "m_Height": height,
        "m_CompleteImageSize": len(pixels),
        "m_MipsStripped": 0,
        "m_TextureFormat": 4,  # RGBA32
        "m_MipCount": 1,
        "m_IsReadable": True,
        "m_IsPreProcessed": False,
        "m_IgnoreMipmapLimit": False,
        "m_MipmapLimitGroupName": "",
        "m_StreamingMipmaps": False,
        "m_StreamingMipmapsPriority": 0,
        "m_ImageCount": 1,
        "m_TextureDimension": 2,
        "m_TextureSettings": {"m_FilterMode": 1, "m_Aniso": 1, "m_MipBias": 0.0, "m_WrapU": 0, "m_WrapV": 0, "m_WrapW": 0},
        "m_LightmapFormat": 0,
        "m_ColorSpace": 1,
        "m_PlatformBlob": [],
        "image data": pixels,
        "m_StreamData": {"offset": 0, "size": 0, "path": ""},
    }


def write_textures(data_dir, file_name: str, textures: list[tuple[str, int, int, tuple[int, int, int, int]]]) -> None:
    builder = unity_synth.FileBuilder([])
    for name, width, height, rgba in textures:
        builder.add(28, texture_value(name, width, height, rgba))  # 28 = Texture2D
    builder.write(data_dir / file_name)


def test_icons_are_exported_from_real_texture2d_objects_preferring_80_by_80(install, tmp_path):  # noqa: F811
    write_textures(
        install.data_dir,
        "sharedassets0.assets",
        [
            ("iron-ingot", 128, 128, (0, 0, 255, 255)),
            ("iron-ingot", 80, 80, (255, 0, 0, 255)),
            ("copper-ingot", 40, 40, (0, 255, 0, 255)),
            ("unrelated", 80, 80, (1, 2, 3, 255)),
        ],
    )
    items = [
        {"id": 1101, "iconPath": "Icons/ItemRecipe/iron-ingot"},
        {"id": 1102, "iconPath": "Icons/ItemRecipe/copper-ingot"},
        {"id": 1103, "iconPath": "Icons/ItemRecipe/not-in-the-game"},
    ]
    out = tmp_path / "icons"
    report = Report()

    assert export_icons(install, items, out, report) == 2

    from PIL import Image

    assert sorted(p.name for p in out.iterdir()) == ["copper-ingot.png", "iron-ingot.png"]
    iron = Image.open(out / "iron-ingot.png").convert("RGBA")
    assert iron.size == (80, 80) and iron.getpixel((10, 10)) == (255, 0, 0, 255)
    copper = Image.open(out / "copper-ingot.png").convert("RGBA")
    assert copper.size == (40, 40) and copper.getpixel((0, 0)) == (0, 255, 0, 255)
    (warning,) = [w for w in report.warnings if "not found" in w]
    assert "1 of 3" in warning


def test_icons_flag_runs_inside_the_full_command(repo, install, monkeypatch):  # noqa: F811
    write_textures(install.data_dir, "sharedassets0.assets", [("iron-ingot", 80, 80, (9, 9, 9, 255))])
    monkeypatch.setattr(cli, "locate_game", lambda *a: install)
    original = cli.export_icons

    def with_icon_paths(inst, items, out_dir, report):
        # the synthetic ItemProto has no IconPath field; give the first item one
        items = [{**items[0], "iconPath": "Icons/ItemRecipe/iron-ingot"}, *items[1:]]
        return original(inst, items, out_dir, report)

    monkeypatch.setattr(cli, "export_icons", with_icon_paths)

    assert cli.main(["--no-decompile", "--icons"]) == 0

    assert (repo / "app" / "public" / "icons" / "iron-ingot.png").is_file()
    assert load_report(repo)["icons"]["exported"] == 1
