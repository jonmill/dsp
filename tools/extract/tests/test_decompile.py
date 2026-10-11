import hashlib
import json
import stat
import sys
import textwrap
from pathlib import Path

import pytest

from dsp_extract.decompile import (
    TYPES_TO_DECOMPILE,
    DriftEntry,
    build_fingerprints,
    decompile_types,
    drift_report,
    extract_method,
    find_ilspycmd,
    fingerprint,
    load_sources,
    normalize_body,
    rotate_previous,
)
from dsp_extract.errors import ExtractError
from dsp_extract.mirrored_methods import MIRRORED
from dsp_extract.report import Report

REPO_ROOT = Path(__file__).resolve().parents[3]

# What ilspycmd prints (tabs, Allman braces), trimmed: two InternalUpdate overloads, a name that only
# starts with the same text, braces inside strings / chars / comments, and a call to a sibling method.
SAMPLE = r"""
using System;
using System.Runtime.CompilerServices;

public struct InserterComponent
{
	#region Sorter state {
	public int id;
	#endregion

	public int[] needs;

	private static readonly string Template = @"{ verbatim ""quoted"" } string";

	// public void Ghost() { }
	/* void Ghost2() { } */
	private string ghost = "void Ghost3() { }";

	/// <summary>Updates { the sorter.</summary>
	[MethodImpl(MethodImplOptions.AggressiveInlining)]
	public uint InternalUpdate(PlanetFactory factory, int[][] needsPool, float power)
	{
		// the brace in this comment { must be ignored
		if (power < 0.1f)
		{
			return 0u; /* block } comment { */
		}
		string text = "a { b } \" c";
		char open = '{';
		char close = '}';
		char quote = '\'';
		char brace = '}';
		string path = @"C:\{dir}\";
		string lone = "{";
		string label = $"id {id} {{literal}} {(power > 1f ? "}" : "{")}";
		return InternalUpdateNoAnim(factory, needsPool, power);
	}

	public uint InternalUpdate(PlanetFactory factory, int[][] needsPool, float power, bool isActive)
	{
		if (isActive)
		{
			return 1u;
		}
		return 2u;
	}

	public uint InternalUpdateNoAnim(PlanetFactory factory, int[][] needsPool, float power)
	{
		return 3u;
	}

	public uint InternalUpdate_Bidirectional(PlanetFactory factory)
	{
		return 4u;
	}

	public void PreInternalUpdate()
	{
		this.id = 5;
	}
}
"""

GENERICS = r"""
public class Utils
{
	private int field = Helper(3);

	public static T Clamp<T>(T value, T low, T high) where T : struct, IComparable<T>
	{
		return value;
	}

	public static List<int> Build<T, U>(Dictionary<T, List<U>> map) where T : class where U : new()
	{
		Probe(5);
		return null;
	}

	// leading comment { that is not part of the method
	public int Twice(int x) => x * 2;

	public int Thrice(int x) => Apply(x, (int y) =>
	{
		return y * 3;
	});

	public int Count => items.Length;

	public Point Origin() => new Point { X = 0, Y = 0 };

	public int Items
	{
		get
		{
			return items.Length;
		}
	}

	public abstract void Abstract(int a);

	public unsafe int Sum(int[] data)
	{
		fixed (int* p = data)
		{
			int total = 0;
			for (int i = 0; i < data.Length; i++)
			{
				total += p[i];
			}
			return total;
		}
	}

	public void Caller()
	{
		Twice(2);
		this.Twice(3);
		Helper(1);
	}
}
"""

NESTED = r"""
public class Outer
{
	public void Update()
	{
		outer = 1;
	}

	public struct Inner
	{
		public void Update(int a)
		{
			inner = 2;
		}
	}
}
"""


# ---- extract_method ---------------------------------------------------------------------------


def test_both_overloads_are_returned_in_source_order_with_their_attributes():
    body = extract_method(SAMPLE, "InternalUpdate")
    assert body is not None
    assert body.startswith("[MethodImpl(MethodImplOptions.AggressiveInlining)]")
    assert "bool isActive" in body
    assert body.index("return 0u;") < body.index("return 2u;")
    assert body.rstrip().endswith("}")
    # not the sibling methods, the fields or the comments
    for other in ("return 3u;", "return 4u;", "return 5;", "Template", "Ghost", "Updates { the sorter"):
        assert other not in body


def test_braces_in_strings_chars_comments_and_interpolation_do_not_break_matching():
    body = extract_method(SAMPLE, "InternalUpdate")
    assert body is not None
    # the first overload is complete (its last statement is there) and the second starts after it
    first, second = body.split("public uint InternalUpdate(PlanetFactory factory, int[][] needsPool, float power, bool isActive)")
    assert "return InternalUpdateNoAnim(factory, needsPool, power);" in first
    assert first.rstrip().endswith("}")
    assert "return 2u;" in second and second.count("{") == second.count("}")
    assert '$"id {id} {{literal}} {(power > 1f ? "}" : "{")}"' in first
    assert "'\\''" in first


def test_a_name_that_only_shares_a_prefix_or_suffix_does_not_match():
    only_noanim = extract_method(SAMPLE, "InternalUpdateNoAnim")
    assert only_noanim is not None
    assert "return 3u;" in only_noanim and "return 2u;" not in only_noanim
    assert extract_method(SAMPLE, "InternalUpdate_Bidirectional").count("return 4u;") == 1
    assert extract_method(SAMPLE, "Update") is None  # PreInternalUpdate / InternalUpdate are other names
    assert extract_method(SAMPLE, "Internal") is None


def test_calls_comments_and_strings_are_not_declarations():
    for name in ("Ghost", "Ghost2", "Ghost3", "Template"):
        assert extract_method(SAMPLE, name) is None
    # InternalUpdateNoAnim is also called inside an overload body: still exactly one declaration
    assert extract_method(SAMPLE, "InternalUpdateNoAnim").count("InternalUpdateNoAnim") == 1


def test_missing_method_and_unbalanced_source_give_none():
    assert extract_method(SAMPLE, "DoesNotExist") is None
    assert extract_method("public void Broken()\n{\n\tif (x)\n\t{\n", "Broken") is None
    assert extract_method("", "Anything") is None


def test_generic_methods_with_constraints():
    clamp = extract_method(GENERICS, "Clamp")
    assert clamp is not None
    assert clamp.startswith("public static T Clamp<T>(T value, T low, T high) where T : struct, IComparable<T>")
    assert clamp.rstrip().endswith("}") and "return value;" in clamp

    build = extract_method(GENERICS, "Build")
    assert build is not None and "where U : new()" in build and "return null;" in build
    # `where T : class` must not make the method body look like a type body: Probe is only a call
    assert extract_method(GENERICS, "Probe") is None


def test_expression_bodied_members_end_at_their_semicolon():
    assert extract_method(GENERICS, "Twice") == "public int Twice(int x) => x * 2;"  # no leading comment, no calls
    thrice = extract_method(GENERICS, "Thrice")
    assert thrice is not None and thrice.rstrip().endswith("});") and "return y * 3;" in thrice
    assert extract_method(GENERICS, "Count") == "public int Count => items.Length;"
    assert extract_method(GENERICS, "Origin") == "public Point Origin() => new Point { X = 0, Y = 0 };"
    items = extract_method(GENERICS, "Items")
    assert items is not None and "return items.Length;" in items


def test_abstract_declaration_and_unsafe_fixed_blocks():
    assert extract_method(GENERICS, "Abstract") == "public abstract void Abstract(int a);"
    total = extract_method(GENERICS, "Sum")
    assert total is not None
    assert total.startswith("public unsafe int Sum(int[] data)")
    assert "fixed (int* p = data)" in total and total.rstrip().endswith("}") and "return total;" in total
    assert extract_method(GENERICS, "Helper") is None  # a field initializer and a call, never a declaration


def test_nested_types_contribute_their_overloads_in_source_order():
    body = extract_method(NESTED, "Update")
    assert body is not None
    assert body.index("outer = 1;") < body.index("inner = 2;")


def test_constructors_are_found_but_the_type_declaration_is_not():
    src = (
        "public struct Cargo\n{\n\tpublic static int[] table;\n\n"
        "\tstatic Cargo()\n\t{\n\t\ttable = new int[2] { 1, 2 };\n\t}\n\n"
        "\tpublic Cargo(int a)\n\t{\n\t\titem = a;\n\t}\n}\n"
    )
    body = extract_method(src, "Cargo")
    assert body is not None
    assert body.startswith("static Cargo()") and "item = a;" in body
    assert "public struct Cargo" not in body and "public static int[] table" not in body


def test_extract_method_survives_crlf_sources():
    body = extract_method(SAMPLE.replace("\n", "\r\n"), "InternalUpdate")
    assert body is not None and "return 2u;" in body


# ---- normalize_body / fingerprint ---------------------------------------------------------------

BODY = """
public uint Run(int a)   // trailing comment
{
	/* block
	   comment */
	int x = a  +  1;

	string s = "two  spaces // not a comment";
	return (uint)x;
}
"""


def test_normalize_strips_comments_blank_lines_and_collapses_whitespace():
    assert normalize_body(BODY) == textwrap.dedent(
        """\
        public uint Run(int a)
        {
        int x = a + 1;
        string s = "two  spaces // not a comment";
        return (uint)x;
        }"""
    )


def test_comment_and_whitespace_changes_keep_the_fingerprint():
    changed = (
        BODY.replace("// trailing comment", "// something else entirely")
        .replace("/* block\n\t   comment */", "// new comment")
        .replace("\t", "        ")
        .replace("a  +  1", "a + 1")
        .replace("\n", "\r\n")
        + "\n\n\n"
    )
    assert normalize_body(changed) == normalize_body(BODY)
    assert fingerprint(changed) == fingerprint(BODY)


def test_a_real_change_or_a_change_inside_a_string_changes_the_fingerprint():
    assert fingerprint(BODY.replace("a  +  1", "a + 2")) != fingerprint(BODY)
    assert fingerprint(BODY.replace("two  spaces", "two spaces")) != fingerprint(BODY)
    assert fingerprint(BODY.replace("(uint)x", "(uint)x + 0u")) != fingerprint(BODY)


def test_fingerprint_is_the_sha256_of_the_normalized_body_and_normalize_is_idempotent():
    normalized = normalize_body(BODY)
    assert normalize_body(normalized) == normalized
    assert fingerprint(BODY) == hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    assert fingerprint(normalized) == fingerprint(BODY)


def test_verbatim_and_char_literals_survive_normalization_untouched():
    src = "string a = @\"x  //  y\"\"  z\";\nchar c = '/';  // done\nchar d = '\\'';"
    assert normalize_body(src) == "string a = @\"x  //  y\"\"  z\";\nchar c = '/';\nchar d = '\\'';"


# ---- drift_report ---------------------------------------------------------------------------------


def doc(**methods: str) -> dict:
    return {
        "gameVersion": "0.10.35.29104",
        "methods": {name: {"sha256": sha, "tsModule": "ignored.ts"} for name, sha in methods.items()},
    }


MIRRORED_TWO = {
    "CargoPath.Update": "app/src/lib/validate/sim/belt.ts",
    "MD5F.Compute": "app/src/lib/blueprint/md5f.ts",
    "PowerSystem.GameTick": "app/src/lib/validate/sim/world.ts",
}


def test_drift_report_flags_changed_missing_and_new_and_skips_unchanged():
    old = {
        "gameVersion": "1",
        "methods": {
            "CargoPath.Update": {"sha256": "aa", "tsModule": "x"},
            "MD5F.Compute": {"sha256": "bb", "tsModule": "x"},
            "Unmirrored.Thing": {"sha256": "cc", "tsModule": "x"},
        },
    }
    new = {
        "gameVersion": "2",
        "methods": {
            "CargoPath.Update": {"sha256": "aa2", "tsModule": "x"},
            "PowerSystem.GameTick": {"sha256": "dd", "tsModule": "x"},
            "Unmirrored.Thing": {"sha256": "different", "tsModule": "x"},
        },
    }
    entries = drift_report(old, new, MIRRORED_TWO)
    assert entries == [
        DriftEntry("CargoPath.Update", "app/src/lib/validate/sim/belt.ts", "changed", None),
        DriftEntry("MD5F.Compute", "app/src/lib/blueprint/md5f.ts", "missing", None),
        DriftEntry("PowerSystem.GameTick", "app/src/lib/validate/sim/world.ts", "new", None),
    ]
    assert drift_report(old, old, MIRRORED_TWO) == []


def test_drift_report_accepts_the_empty_file_on_either_side():
    new = doc(**{"CargoPath.Update": "aa"})
    assert [(e.method, e.status) for e in drift_report({}, new, MIRRORED_TWO)] == [("CargoPath.Update", "new")]
    assert [(e.method, e.status) for e in drift_report(new, {}, MIRRORED_TWO)] == [("CargoPath.Update", "missing")]
    assert drift_report({}, {}, MIRRORED_TWO) == []


def test_the_committed_fingerprints_file_is_accepted():
    committed = json.loads((REPO_ROOT / "data" / "fingerprints.json").read_text(encoding="utf-8"))
    assert committed == {}
    assert drift_report(committed, committed, MIRRORED) == []
    assert {e.status for e in drift_report(committed, doc(**{"CargoPath.Update": "aa"}), MIRRORED)} == {"new"}


def test_malformed_fingerprint_files_fail_loudly():
    with pytest.raises(ExtractError, match="old fingerprints"):
        drift_report({"methods": []}, {}, MIRRORED_TWO)
    with pytest.raises(ExtractError, match="CargoPath.Update"):
        drift_report({"methods": {"CargoPath.Update": {"tsModule": "x"}}}, doc(), MIRRORED_TWO)
    with pytest.raises(ExtractError, match="new fingerprints"):
        drift_report({}, [], MIRRORED_TWO)  # type: ignore[arg-type]


def test_changed_entries_carry_a_unified_diff_when_both_sources_are_given():
    old_src = "public class CargoPath\n{\n\tpublic void Update()\n\t{\n\t\tspeed = 1;\n\t\t// same\n\t\tmove();\n\t}\n}\n"
    new_src = "public class CargoPath\n{\n\tpublic void Update()\n\t{\n\t\tspeed = 2;\n\t\tmove();\n\t}\n}\n"
    old = build_fingerprints("1", {"CargoPath": old_src}, {"CargoPath.Update": "belt.ts"})
    new = build_fingerprints("2", {"CargoPath": new_src}, {"CargoPath.Update": "belt.ts"})
    (entry,) = drift_report(
        old,
        new,
        {"CargoPath.Update": "belt.ts"},
        old_sources={"CargoPath": old_src},
        new_sources={"CargoPath": new_src},
    )
    assert entry.status == "changed" and entry.diff is not None
    lines = entry.diff.splitlines()
    assert "-speed = 1;" in lines and "+speed = 2;" in lines
    assert "// same" not in entry.diff  # the diff is over the normalized bodies
    assert "CargoPath.Update" in lines[0] and "CargoPath.Update" in lines[1]
    # no diff without the previous source, or when the method is gone from it
    assert drift_report(old, new, {"CargoPath.Update": "belt.ts"})[0].diff is None
    assert drift_report(old, new, {"CargoPath.Update": "belt.ts"}, old_sources={}, new_sources={"CargoPath": new_src})[0].diff is None


def test_missing_entries_diff_the_old_body_against_nothing():
    old_src = "public class MD5F\n{\n\tpublic static string Compute(string s)\n\t{\n\t\treturn s;\n\t}\n}\n"
    old = build_fingerprints("1", {"MD5F": old_src}, {"MD5F.Compute": "md5f.ts"})
    (entry,) = drift_report(
        old, {}, {"MD5F.Compute": "md5f.ts"}, old_sources={"MD5F": old_src}, new_sources={}
    )
    assert entry.status == "missing" and entry.diff is not None
    assert "-return s;" in entry.diff.splitlines()


# ---- build_fingerprints ---------------------------------------------------------------------------


def test_build_fingerprints_hashes_every_found_method_and_warns_about_the_rest():
    sources = {"CargoPath": SAMPLE.replace("InserterComponent", "CargoPath").replace("InternalUpdate", "Update")}
    mirrored = {"CargoPath.Update": "belt.ts", "CargoPath.Nope": "belt.ts", "Gone.Method": "x.ts"}
    report = Report()
    result = build_fingerprints("0.10.35.29104", sources, mirrored, report)
    assert result["gameVersion"] == "0.10.35.29104"
    assert list(result["methods"]) == ["CargoPath.Update"]
    entry = result["methods"]["CargoPath.Update"]
    assert entry["tsModule"] == "belt.ts"
    assert entry["sha256"] == fingerprint(extract_method(sources["CargoPath"], "Update"))
    assert len(report.warnings) == 2
    assert any("CargoPath.Nope" in w for w in report.warnings)
    assert any("Gone.Method" in w and "not decompiled" in w for w in report.warnings)
    json.dumps(result)  # serializable as data/fingerprints.json
    assert drift_report(result, result, mirrored) == []


# ---- mirrored methods / type list -------------------------------------------------------------------


def test_every_mirrored_method_is_named_type_dot_method_and_has_a_ts_module():
    assert len(MIRRORED) == 18
    for method, module in MIRRORED.items():
        type_name, _, name = method.rpartition(".")
        assert type_name and name, method
        assert module.startswith("app/src/lib/") and module.endswith(".ts"), (method, module)
    assert MIRRORED["CargoPath.Update"] == "app/src/lib/validate/sim/belt.ts"


def test_every_mirrored_type_is_decompiled_and_the_list_has_what_the_readers_need():
    mirrored_types = {method.rpartition(".")[0] for method in MIRRORED}
    assert mirrored_types <= set(TYPES_TO_DECOMPILE)
    for needed in ("GameConfig", "Cargo", "CargoPath", "CargoTraffic", "BlueprintData", "MD5F", "LabComponent", "PrefabDesc"):
        assert needed in TYPES_TO_DECOMPILE
    assert len(set(TYPES_TO_DECOMPILE)) == len(TYPES_TO_DECOMPILE)


# ---- find_ilspycmd ----------------------------------------------------------------------------------


def test_find_ilspycmd_is_none_when_path_is_empty(monkeypatch):
    monkeypatch.setenv("PATH", "")
    assert find_ilspycmd() is None


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX executable bit")
def test_find_ilspycmd_returns_the_executable_on_path(tmp_path, monkeypatch):
    exe = tmp_path / "ilspycmd"
    exe.write_text("#!/bin/sh\nexit 0\n")
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", str(tmp_path))
    assert find_ilspycmd() == str(exe)


# ---- decompile_types (against a fake ilspycmd) --------------------------------------------------------

FAKE_ILSPY = """#!{python}
import json, sys, time
args = sys.argv[1:]
with open({log!r}, "a") as f:
    f.write(json.dumps(args) + "\\n")
type_name = args[args.index("-t") + 1]
if type_name == "Slow":
    time.sleep(30)
if type_name == "Boom":
    sys.stderr.write("System.InvalidOperationException: Could not find type definition Boom\\n")
    sys.exit(70)
if type_name == "Empty":
    sys.exit(0)
sys.stdout.write("public class " + type_name + "\\r\\n{{\\r\\n\\tpublic int " + type_name.lower() + ";\\r\\n}}\\r\\n")
"""


@pytest.fixture
def fake_ilspy(tmp_path):
    if sys.platform == "win32":
        pytest.skip("shebang script")
    log = tmp_path / "calls.log"
    exe = tmp_path / "bin" / "ilspycmd"
    exe.parent.mkdir()
    exe.write_text(FAKE_ILSPY.format(python=sys.executable, log=str(log)))
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    managed = tmp_path / "Managed"
    managed.mkdir()
    (managed / "Assembly-CSharp.dll").write_bytes(b"")
    return exe, managed, log


def test_decompile_types_runs_ilspycmd_per_type_and_writes_the_sources(fake_ilspy, tmp_path):
    exe, managed, log = fake_ilspy
    out = tmp_path / "local" / "decompiled"
    report = Report()
    result = decompile_types(str(exe), managed, ["CargoPath", "ProtoSet`1"], out, report)
    assert result == {"CargoPath": out / "CargoPath.cs", "ProtoSet`1": out / "ProtoSet`1.cs"}
    assert (out / "CargoPath.cs").read_text(encoding="utf-8") == "public class CargoPath\n{\n\tpublic int cargopath;\n}\n"
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    dll = str(managed / "Assembly-CSharp.dll")
    assert calls[0] == ["--disable-updatecheck", "-r", str(managed), "-t", "CargoPath", dll]
    assert calls[1][4] == "ProtoSet`1"
    assert report.warnings == []


def test_one_failing_type_is_a_warning_and_the_rest_still_decompile(fake_ilspy, tmp_path):
    exe, managed, _ = fake_ilspy
    out = tmp_path / "out"
    out.mkdir()
    (out / "Boom.cs").write_text("stale from a previous run")
    report = Report()
    result = decompile_types(str(exe), managed, ["CargoPath", "Boom", "Empty", "MD5F"], out, report)
    assert sorted(result) == ["CargoPath", "MD5F"]
    assert not (out / "Boom.cs").exists()  # no stale file is left looking like a success
    assert len(report.warnings) == 2
    assert any("Boom" in w and "70" in w for w in report.warnings)
    assert any("Empty" in w and "no output" in w for w in report.warnings)
    section = report.get("decompile")
    assert section["decompiled"] == ["CargoPath", "MD5F"]
    assert sorted(section["failed"]) == ["Boom", "Empty"]
    assert not report.has_errors


def test_a_timeout_is_a_warning_and_the_run_continues(fake_ilspy, tmp_path):
    exe, managed, _ = fake_ilspy
    report = Report()
    result = decompile_types(str(exe), managed, ["Slow", "CargoPath"], tmp_path / "out", report, timeout=0.5)
    assert list(result) == ["CargoPath"]
    assert any("Slow" in w and "timed out" in w for w in report.warnings)


def test_decompile_types_works_without_a_report_and_rejects_unsafe_type_names(fake_ilspy, tmp_path):
    exe, managed, _ = fake_ilspy
    result = decompile_types(str(exe), managed, ["CargoPath", "../escape", "a/b"], tmp_path / "out")
    assert list(result) == ["CargoPath"]
    assert not (tmp_path / "escape.cs").exists()
    report = Report()
    decompile_types(str(exe), managed, ["../escape"], tmp_path / "out", report)
    assert any("../escape" in w for w in report.warnings)


def test_missing_assembly_or_unrunnable_ilspycmd_fails_loudly(fake_ilspy, tmp_path):
    exe, managed, _ = fake_ilspy
    (managed / "Assembly-CSharp.dll").unlink()
    with pytest.raises(ExtractError, match="Assembly-CSharp.dll"):
        decompile_types(str(exe), managed, ["CargoPath"], tmp_path / "out")
    (managed / "Assembly-CSharp.dll").write_bytes(b"")
    with pytest.raises(ExtractError, match="ilspycmd"):
        decompile_types(str(tmp_path / "does-not-exist"), managed, ["CargoPath"], tmp_path / "out")


# ---- keeping the previous decompile -----------------------------------------------------------------------


def test_rotate_previous_renames_the_directory_and_load_sources_reads_it_back(tmp_path):
    current = tmp_path / "local" / "decompiled"
    current.mkdir(parents=True)
    (current / "CargoPath.cs").write_text("class CargoPath {}\n", encoding="utf-8")
    (current / "ProtoSet`1.cs").write_text("class ProtoSet<T> {}\n", encoding="utf-8")
    (current / "notes.txt").write_text("ignored")
    previous = rotate_previous(current)
    assert previous == tmp_path / "local" / "decompiled.prev"
    assert not current.exists()
    assert load_sources(previous) == {"CargoPath": "class CargoPath {}\n", "ProtoSet`1": "class ProtoSet<T> {}\n"}

    # an older .prev is replaced, and rotating a missing directory is a no-op
    current.mkdir()
    (current / "MD5F.cs").write_text("class MD5F {}\n", encoding="utf-8")
    assert rotate_previous(current) == previous
    assert load_sources(previous) == {"MD5F": "class MD5F {}\n"}
    assert rotate_previous(current) is None
    assert load_sources(tmp_path / "nowhere") == {}
