import io
import json

from dsp_extract.report import Report


def test_levels_are_collected_and_counted():
    report = Report()
    report.info("a")
    report.warn("b", item_id=3)
    report.error("c")
    assert report.infos == ["a"] and report.warnings == ["b"] and report.errors == ["c"]
    assert report.has_errors
    assert not Report().has_errors
    assert report.to_dict()["counts"] == {"info": 1, "warn": 1, "error": 1}
    assert report.entries[1].context == {"item_id": 3}


def test_collider_layers_are_deduplicated_per_layer_trigger_name_shape():
    report = Report()
    for item_id in (1, 2, 1):
        report.note_collider(layer=3, layer_name="Build", is_trigger=False, name="body", shape="box", usage="build", item_id=item_id)
    report.note_collider(layer=3, layer_name="Build", is_trigger=True, name="body", shape="box", usage="other", item_id=1)
    rows = report.sections["collider_layers_seen"]
    assert len(rows) == 2
    assert rows[0]["count"] == 3 and rows[0]["example_items"] == [1, 2]
    assert rows[1]["usage"] == "other"


def test_write_creates_parent_folders_and_round_trips(tmp_path):
    report = Report()
    report.set("unity_version", "2022.3.62f3c1")
    report.set_building(2303, {"status": "extracted"})
    report.warn("careful: 中文")
    out = report.write(tmp_path / "local" / "extract-report.json")
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["unity_version"] == "2022.3.62f3c1"
    assert data["per_building_geometry"]["2303"] == {"status": "extracted"}
    assert data["entries"] == [{"level": "warn", "message": "careful: 中文", "context": {}}]
    assert set(data) >= {"files_loaded", "protosets_found", "collider_layers_seen", "counts", "report_version"}


def test_write_tolerates_non_json_values(tmp_path):
    report = Report()
    report.set("odd", {"path": tmp_path})
    assert json.loads(report.write(tmp_path / "r.json").read_text())["odd"]["path"] == str(tmp_path)


def test_summary_is_human_readable_and_truncates_long_lists():
    report = Report()
    report.set("unity_version", "2022.3.62f3c1")
    report.sections["files_loaded"].append({"name": "resources.assets", "objects": 1234})
    report.sections["files_loaded"].append({"name": "sharedassets9.assets", "error": "boom"})
    report.sections["protosets_found"]["ItemProtoSet"] = {"entries": 400, "signature": "Item ABC"}
    report.set_building(2303, {"status": "extracted", "name_key": "组装机"})
    report.set_building(2011, {"status": "partial", "name_key": "分拣器"})
    report.note_collider(layer=0, layer_name=None, is_trigger=False, name="body", shape="box", usage="build")
    for i in range(40):
        report.warn(f"warning {i}")
    report.error("something broke")
    text = report.summary()
    assert "Unity version: 2022.3.62f3c1" in text
    assert "resources.assets: 1234 objects" in text and "sharedassets9.assets: error: boom" in text
    assert "ItemProtoSet: 400 entries, signature Item ABC" in text
    assert "Buildings: 2 (1 extracted, 1 partial)" in text and "2011 分拣器: partial" in text
    assert "layer 0, trigger=False, name='body', box -> build (x1)" in text
    assert "Errors: 1" in text and "something broke" in text
    assert "Warnings: 40" in text and "warning 24" in text and "warning 25" not in text
    assert "... and 15 more" in text


def test_print_summary_writes_to_the_given_stream():
    out = io.StringIO()
    Report().print_summary(out)
    assert out.getvalue().startswith("== dsp-extract report ==")
