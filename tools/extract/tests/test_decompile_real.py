"""`decompile_types` against the real ilspycmd, using a .NET runtime assembly as a stand-in for Assembly-CSharp.dll.

Skipped unless `ilspycmd` is on PATH and a .NET runtime directory (`<dotnet root>/shared/Microsoft.NETCore.App/<v>/`)
can be found next to `dotnet` or through DOTNET_ROOT. `System.Collections.dll` is copied to
`Managed/Assembly-CSharp.dll`; the other runtime assemblies are linked beside it so ilspycmd can resolve `-r`.
"""

import os
import shutil
import sys
from pathlib import Path

import pytest

from dsp_extract.decompile import (
    build_fingerprints,
    decompile_types,
    drift_report,
    extract_method,
    find_ilspycmd,
    load_sources,
)
from dsp_extract.report import Report


def runtime_dir() -> Path | None:
    roots = [os.environ.get("DOTNET_ROOT")]
    dotnet = shutil.which("dotnet")
    if dotnet:
        roots.append(str(Path(dotnet).resolve().parent))
    for root in roots:
        if not root:
            continue
        candidates = sorted(Path(root).glob("shared/Microsoft.NETCore.App/*/System.Collections.dll"))
        if candidates:
            return candidates[-1].parent
    return None


ILSPY = find_ilspycmd()
RUNTIME = runtime_dir()

pytestmark = pytest.mark.skipif(
    ILSPY is None or RUNTIME is None or sys.platform == "win32",
    reason="needs ilspycmd on PATH and a .NET runtime directory",
)


@pytest.fixture
def managed(tmp_path):
    managed = tmp_path / "Managed"
    managed.mkdir()
    for dll in RUNTIME.glob("*.dll"):
        (managed / dll.name).symlink_to(dll)
    shutil.copyfile(RUNTIME / "System.Collections.dll", managed / "Assembly-CSharp.dll")
    return managed


def test_real_ilspycmd_decompiles_generic_types_and_skips_a_missing_one(managed, tmp_path):
    out = tmp_path / "local" / "decompiled"
    report = Report()
    types = ["System.Collections.Generic.Stack`1", "System.Collections.Generic.DoesNotExist", "System.Collections.Generic.LinkedList`1"]
    result = decompile_types(ILSPY, managed, types, out, report, timeout=120)
    assert sorted(result) == ["System.Collections.Generic.LinkedList`1", "System.Collections.Generic.Stack`1"]
    assert len(report.warnings) == 1 and "DoesNotExist" in report.warnings[0]

    sources = load_sources(out)
    stack = sources["System.Collections.Generic.Stack`1"]
    assert "public class Stack<T>" in stack
    push = extract_method(stack, "Push")
    assert push is not None and push.lstrip().startswith("public void Push(T item)") and push.rstrip().endswith("}")
    assert extract_method(stack, "TryPop") is not None  # an attribute in the parameter list

    mirrored = {"Stack`1.Push": "push.ts"}
    first = build_fingerprints("1", {"Stack`1": stack}, mirrored)
    second = build_fingerprints("1", {"Stack`1": (out / "System.Collections.Generic.Stack`1.cs").read_text(encoding="utf-8")}, mirrored)
    assert first == second
    assert drift_report(first, second, mirrored) == []
