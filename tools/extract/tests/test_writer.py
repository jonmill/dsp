"""Tests for the atomic JSON writer."""

from __future__ import annotations

import json
import os

import pytest

from dsp_extract import writer
from dsp_extract.writer import write_atomic


def leftovers(directory) -> list[str]:
    return sorted(p.name for p in directory.iterdir())


def test_write_atomic_writes_the_file(tmp_path):
    target = tmp_path / "dsp-1.json"
    write_atomic(target, {"meta": {"gameVersion": "1"}, "items": [{"id": 1}, {"id": 2}]})
    assert json.loads(target.read_text(encoding="utf-8")) == {"meta": {"gameVersion": "1"}, "items": [{"id": 1}, {"id": 2}]}
    assert leftovers(tmp_path) == ["dsp-1.json"]


def test_write_atomic_creates_missing_parent_folders(tmp_path):
    target = tmp_path / "a" / "b" / "data.json"
    write_atomic(target, {"x": 1})
    assert json.loads(target.read_text(encoding="utf-8")) == {"x": 1}


def test_write_atomic_replaces_an_existing_file(tmp_path):
    target = tmp_path / "data.json"
    target.write_text('{"old": true}', encoding="utf-8")
    write_atomic(target, {"new": True})
    assert json.loads(target.read_text(encoding="utf-8")) == {"new": True}
    assert leftovers(tmp_path) == ["data.json"]


def test_serialization_failure_leaves_the_target_untouched_and_no_tmp_file(tmp_path):
    target = tmp_path / "data.json"
    target.write_text('{"old": true}', encoding="utf-8")
    with pytest.raises(TypeError):
        write_atomic(target, {"ok": 1, "bad": object()})
    assert target.read_text(encoding="utf-8") == '{"old": true}'
    assert leftovers(tmp_path) == ["data.json"]


def test_serialization_failure_creates_no_file_when_there_was_none(tmp_path):
    target = tmp_path / "sub" / "data.json"
    with pytest.raises(TypeError):
        write_atomic(target, {"bad": {1, 2}})
    assert not target.exists()
    assert not any(tmp_path.rglob("*.tmp")) and not any(p.is_file() for p in tmp_path.rglob("*"))


def test_nan_is_rejected_because_it_is_not_valid_json(tmp_path):
    target = tmp_path / "data.json"
    target.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="NaN|nan|not valid JSON"):
        write_atomic(target, {"x": float("nan")})
    with pytest.raises(ValueError):
        write_atomic(target, {"x": float("inf")})
    assert target.read_text(encoding="utf-8") == "{}"
    assert leftovers(tmp_path) == ["data.json"]


def test_the_error_names_the_json_path_of_the_non_finite_number(tmp_path):
    data = {"buildings": [{"itemId": 1}, {"itemId": 2, "geometry": {"colliders": [{"halfExtents": [1.0, float("nan"), 2.0]}]}}]}
    with pytest.raises(ValueError) as excinfo:
        write_atomic(tmp_path / "data.json", data)
    assert "$.buildings[1].geometry.colliders[0].halfExtents[1]" in str(excinfo.value)
    assert not (tmp_path / "data.json").exists()


def test_failure_during_the_final_replace_removes_the_tmp_file_and_keeps_the_target(tmp_path, monkeypatch):
    target = tmp_path / "data.json"
    target.write_text('{"old": true}', encoding="utf-8")

    def broken_replace(src, dst):
        raise OSError("disk went away")

    monkeypatch.setattr(os, "replace", broken_replace)
    with pytest.raises(OSError, match="disk went away"):
        write_atomic(target, {"new": True})
    assert target.read_text(encoding="utf-8") == '{"old": true}'
    assert leftovers(tmp_path) == ["data.json"]


def test_failure_while_writing_the_tmp_file_removes_it(tmp_path, monkeypatch):
    target = tmp_path / "data.json"
    real_fsync = os.fsync

    def broken_fsync(fd):
        real_fsync(fd)
        raise OSError("no space left on device")

    monkeypatch.setattr(os, "fsync", broken_fsync)
    with pytest.raises(OSError, match="no space"):
        write_atomic(target, {"new": True})
    assert leftovers(tmp_path) == []


def test_default_format_keeps_one_record_per_line_in_the_big_arrays(tmp_path):
    target = tmp_path / "data.json"
    write_atomic(target, {"items": [{"id": 1}, {"id": 2}], "constants": {"a": 1}})
    lines = target.read_text(encoding="utf-8").splitlines()
    assert '  {"id":1},' in lines and '  {"id":2}' in lines


def test_a_custom_serializer_can_be_given(tmp_path):
    target = tmp_path / "fingerprints.json"
    write_atomic(target, {"methods": {"B": 1, "A": 2}}, dumps=lambda d: json.dumps(d, indent=2, sort_keys=True) + "\n")
    assert target.read_text(encoding="utf-8") == '{\n  "methods": {\n    "A": 2,\n    "B": 1\n  }\n}\n'


def test_dumps_json_is_sorted_indented_and_ends_with_a_newline():
    assert writer.dumps_json({"b": [1], "a": {"c": 2}}) == '{\n  "a": {\n    "c": 2\n  },\n  "b": [\n    1\n  ]\n}\n'
