"""
Token-usage accounting type used across v2.

Lives in its own module so that :mod:`v2.telemetry` and :mod:`v2.workflow`
can both depend on it without pulling in the whole providers package.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Usage:
    """Prompt / completion token counts for a single chat turn."""

    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens
