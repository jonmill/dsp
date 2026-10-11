"""Minimal parser for Valve KeyValues text (Steam `libraryfolders.vdf`, `appmanifest_*.acf`).

Supports nested `{ }` blocks, quoted and bare tokens, `//` line comments and the escapes
`\\"`, `\\\\`, `\\n`, `\\t`. A block becomes a `dict`; a leaf becomes a `str`. If a key repeats
inside one block the last value wins. Keys keep the case they were written in.
"""

from __future__ import annotations

from typing import Iterator, Union

VdfValue = Union[str, "dict[str, VdfValue]"]

_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t"}
_BARE_STOP = set(' \t\r\n{}"')


class VdfError(ValueError):
    """Raised for malformed KeyValues text; the message names the line."""


def _tokenize(text: str) -> Iterator[tuple[str, str, int]]:
    """Yield `(kind, value, line)`; kind is `"str"`, `"{"` or `"}"`."""
    i, n, line = 0, len(text), 1
    if text.startswith("﻿"):
        i = 1
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
        elif c in " \t\r":
            i += 1
        elif c == "/" and text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif c in "{}":
            yield c, c, line
            i += 1
        elif c == '"':
            start_line = line
            i += 1
            out: list[str] = []
            while True:
                if i >= n:
                    raise VdfError(f"unterminated string starting on line {start_line}")
                c = text[i]
                if c == '"':
                    i += 1
                    break
                if c == "\\" and i + 1 < n:
                    mapped = _ESCAPES.get(text[i + 1])
                    if mapped is not None:
                        out.append(mapped)
                        i += 2
                        continue
                if c == "\n":
                    line += 1
                out.append(c)
                i += 1
            yield "str", "".join(out), start_line
        else:
            start = i
            while i < n and text[i] not in _BARE_STOP:
                if text.startswith("//", i):
                    break
                i += 1
            yield "str", text[start:i], line


def parse(text: str) -> dict[str, VdfValue]:
    """Parse KeyValues `text` into nested dicts of strings."""
    tokens = list(_tokenize(text))
    pos = 0

    def block(nested: bool) -> dict[str, VdfValue]:
        nonlocal pos
        result: dict[str, VdfValue] = {}
        while pos < len(tokens):
            kind, key, line = tokens[pos]
            if kind == "}":
                if not nested:
                    raise VdfError(f"unexpected '}}' on line {line}")
                pos += 1
                return result
            if kind == "{":
                raise VdfError(f"unexpected '{{' on line {line}, expected a key")
            pos += 1
            if pos >= len(tokens):
                raise VdfError(f"key {key!r} on line {line} has no value")
            vkind, value, _ = tokens[pos]
            if vkind == "}":
                raise VdfError(f"key {key!r} on line {line} has no value")
            pos += 1
            if vkind == "{":
                result[key] = block(True)
            else:
                result[key] = value
        if nested:
            raise VdfError("unexpected end of input: missing '}'")
        return result

    return block(False)
