"""Errors shared by the game-reading modules (kept apart so none of them import each other)."""

from __future__ import annotations


class ExtractError(Exception):
    """The game files could not be read: a missing file, class or key, or an unusable value."""
