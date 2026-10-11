"""`dsp-extract` command line. Each subcommand is a function in its own module, added here."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

from . import fixture


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dsp-extract", description="Extract Dyson Sphere Program data into the planner's GameData JSON"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    fx = sub.add_parser("fixture", help="build the fixture GameData from a dsp-parser dump")
    fx.add_argument("--from", dest="src", type=Path, required=True, metavar="DIR", help="dsp-parser data directory")
    fx.add_argument("--out", type=Path, required=True, metavar="FILE", help="output GameData JSON path")
    fx.set_defaults(handler=lambda args: fixture.run(args.src, args.out))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
