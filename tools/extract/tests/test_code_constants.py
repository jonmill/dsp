from dsp_extract.code_constants import parse_constants
from dsp_extract.constants import DEFAULT_CONSTANTS
from dsp_extract.report import Report

CARGO = """
public struct Cargo
{
	public static readonly int[] incTableMilli = new int[11]
	{
		0, 125, 200, 225, 250, 275, 300, 325, 350, 375,
		400
	};

	public static readonly int[] accTableMilli = new int[11]
	{
		0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250,
		2500
	};

	public static readonly int[] powerTableRatio = new int[11]
	{
		0, 300, 700, 1100, 1500, 1900, 2300, 2700, 3100, 3500,
		3900
	};

	public short item;
}
"""

CARGO_PATH = """
public class CargoPath
{
	public const int kCargoLength = 10;

	public const int kMaxCargoFlowSpeedPerSecond = 120;
}
"""


def test_tables_and_cargo_length_are_parsed_with_their_sources():
    values, sources = parse_constants({"Cargo": CARGO, "CargoPath": CARGO_PATH})
    assert values == {
        "incTableMilli": [0, 125, 200, 225, 250, 275, 300, 325, 350, 375, 400],
        "accTableMilli": [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500],
        "powerTableRatio": [0, 300, 700, 1100, 1500, 1900, 2300, 2700, 3100, 3500, 3900],
        "cargoLength": 10,
    }
    assert sources == {
        "incTableMilli": "decompiled:Cargo.incTableMilli",
        "accTableMilli": "decompiled:Cargo.accTableMilli",
        "powerTableRatio": "decompiled:Cargo.powerTableRatio",
        "cargoLength": "decompiled:CargoPath.kCargoLength",
    }


def test_the_parsed_keys_are_constants_keys_and_equal_the_researched_defaults():
    values, sources = parse_constants({"Cargo": CARGO, "CargoPath": CARGO_PATH})
    assert set(values) == set(sources) <= set(DEFAULT_CONSTANTS)
    for key, value in values.items():
        assert value == DEFAULT_CONSTANTS[key], key


def test_the_one_line_form_from_the_brief():
    cargo = "public static readonly int[] incTableMilli = new int[11] { 0, 125, 200, 225, 250, 275, 300, 325, 350, 375, 400 };"
    values, sources = parse_constants({"Cargo": cargo})
    assert values == {"incTableMilli": [0, 125, 200, 225, 250, 275, 300, 325, 350, 375, 400]}
    assert sources == {"incTableMilli": "decompiled:Cargo.incTableMilli"}


def test_missing_values_are_absent_so_defaults_remain():
    assert parse_constants({}) == ({}, {})
    assert parse_constants({"Cargo": "public struct Cargo { public short item; }", "CargoPath": "class CargoPath {}"}) == ({}, {})
    values, sources = parse_constants({"Cargo": CARGO.replace("accTableMilli", "renamedTable")})
    assert sorted(values) == ["incTableMilli", "powerTableRatio"]
    assert sorted(sources) == ["incTableMilli", "powerTableRatio"]
    # types are looked up by name: the tables are not read out of CargoPath, nor kCargoLength out of Cargo
    assert parse_constants({"CargoPath": CARGO}) == ({}, {})
    assert parse_constants({"Cargo": CARGO_PATH}) == ({}, {})


def test_static_constructor_assignment_is_read():
    cargo = """
public struct Cargo
{
	public static int[] incTableMilli;

	public static int[] accTableMilli;

	static Cargo()
	{
		incTableMilli = new int[11] { 0, 125, 200, 225, 250, 275, 300, 325, 350, 375, 400 };
		Cargo.accTableMilli = new int[11]
		{
			0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500,
		};
	}
}
"""
    values, _ = parse_constants({"Cargo": cargo})
    assert values["incTableMilli"][-1] == 400
    assert values["accTableMilli"] == DEFAULT_CONSTANTS["accTableMilli"]


def test_comments_are_ignored_and_commented_out_definitions_are_not_read():
    cargo = """
public struct Cargo
{
	// public static readonly int[] incTableMilli = new int[2] { 9, 9 };
	/* public static readonly int[] accTableMilli = new int[2] { 8, 8 }; */
	public static readonly int[] incTableMilli = new int[3]
	{
		0, // none
		125, /* level 1 */
		200
	};
}
"""
    values, _ = parse_constants({"Cargo": cargo})
    assert values == {"incTableMilli": [0, 125, 200]}


def test_other_initializer_forms_and_number_spellings():
    cargo = """
public struct Cargo
{
	public static readonly int[] incTableMilli = new[] { 0, 0x7D, 200 };
	public static readonly long[] accTableMilli = new long[3] { 0L, 250L, -500L };
	public static readonly double[] powerTableRatio = new double[3] { 0.0, 300.0, 700.0 };
}
"""
    values, _ = parse_constants({"Cargo": cargo})
    assert values == {"incTableMilli": [0, 125, 200], "accTableMilli": [0, 250, -500], "powerTableRatio": [0, 300, 700]}
    assert all(type(v) is int for table in values.values() for v in table)

    values, _ = parse_constants({"Cargo": "public static readonly int[] incTableMilli = [0, 125, 200];"})
    assert values == {"incTableMilli": [0, 125, 200]}


def test_fractional_tables_are_not_used_because_the_unit_would_be_wrong():
    # the planner stores permille integers; a table of fractions (0.125, 1.3, ...) must not slip in as-is
    cargo = "public static readonly double[] incTableMilli = new double[3] { 0.0, 0.125, 0.2 };"
    report = Report()
    assert parse_constants({"Cargo": cargo}, report) == ({}, {})
    (warning,) = [w for w in report.warnings if w.startswith("Cargo.incTableMilli")]  # the other tables are "not found"
    assert "integer" in warning and "default" in warning


def test_unparseable_and_inconsistent_definitions_warn_and_stay_absent():
    report = Report()
    cargo = (
        "public static readonly int[] incTableMilli = new int[11] { 0, 125 };\n"  # declared size 11, two elements
        "public static readonly int[] accTableMilli = BuildTable();\n"
        "public static readonly int[] powerTableRatio = new int[2] { 0, BaseCost * 2 };\n"
    )
    assert parse_constants({"Cargo": cargo, "CargoPath": "class CargoPath { public const int kCargoLength = Size * 2; }"}, report) == ({}, {})
    assert len(report.warnings) == 4
    assert any("incTableMilli" in w and "11" in w for w in report.warnings)
    assert any("accTableMilli" in w for w in report.warnings)
    assert any("powerTableRatio" in w for w in report.warnings)
    assert any("kCargoLength" in w for w in report.warnings)


def test_a_type_that_was_not_decompiled_is_silent_and_a_type_without_the_constant_warns():
    report = Report()
    parse_constants({}, report)
    assert report.warnings == []  # decompile_types already warned about the missing type
    parse_constants({"Cargo": "public struct Cargo {}"}, report)
    assert len(report.warnings) == 3  # the three tables; CargoPath was not decompiled, so kCargoLength is silent
    for field in ("incTableMilli", "accTableMilli", "powerTableRatio"):
        assert any(f"Cargo.{field}" in w and "not found" in w for w in report.warnings), field


def test_cargo_length_spellings():
    for declaration in (
        "public const int kCargoLength = 10;",
        "public static readonly int kCargoLength = 10;",
        "public static int kCargoLength = 10;",
        "private const int kCargoLength = 10 ;",
    ):
        values, sources = parse_constants({"CargoPath": f"public class CargoPath {{ {declaration} }}"})
        assert values == {"cargoLength": 10}, declaration
        assert sources == {"cargoLength": "decompiled:CargoPath.kCargoLength"}
    # a different value is reported as read, not as the default
    values, _ = parse_constants({"CargoPath": "public class CargoPath { public const int kCargoLength = 12; }"})
    assert values == {"cargoLength": 12}
