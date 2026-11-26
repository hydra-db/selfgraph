from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from .._serde import json_iso

__all__ = ["UNREADABLE_DECIMAL", "normalize"]

UNREADABLE_DECIMAL = "Kuzu cannot return a negative DECIMAL between -0.1 and 0"
_SAFE_INTEGER = 2**53 - 1
_DOUBLE_DIGITS = 15
_MICROS_PER_DAY = 86_400_000_000
_MICROS_PER_HOUR = 3_600_000_000
_MICROS_PER_MINUTE = 60_000_000
_MICROS_PER_SECOND = 1_000_000


def _integer(value: int) -> int | str:
    """Keep an integer a number inside the safe range and render it as a string beyond it, as toJsonable does.

    @param value (int): the integer.
    @return (int | str): the number, or its decimal text.
    """
    return value if abs(value) <= _SAFE_INTEGER else str(value)


def _decimal(value: Decimal) -> int | float | str:
    """Render a DECIMAL as the number a double holds exactly, or as its plain decimal text when it needs more digits.

    @param value (Decimal): the DECIMAL, with the scale of its column.
    @return (int | float | str): an integer for scale 0, a float of at most 15 digits, else the exact text.
    """
    _, digits, exponent = value.as_tuple()
    if exponent >= 0:
        return _integer(int(value))
    return float(value) if len(digits) <= _DOUBLE_DIGITS else format(value, "f")


def _duration(value: timedelta) -> str:
    """Format an interval as an ISO 8601 duration of days and a clock, with months counted as 30 days.

    @param value (timedelta): the interval.
    @return (str): the duration, such as P1DT2H3M4.5S, or PT0S when it is empty.
    """
    if value < timedelta(0):
        return f"-{_duration(-value)}"
    micros = (value.days * 86_400 + value.seconds) * _MICROS_PER_SECOND + value.microseconds
    days, rest = divmod(micros, _MICROS_PER_DAY)
    hours, rest = divmod(rest, _MICROS_PER_HOUR)
    minutes, rest = divmod(rest, _MICROS_PER_MINUTE)
    seconds, fraction = divmod(rest, _MICROS_PER_SECOND)
    second = f"{seconds}.{fraction:06d}".rstrip("0") if fraction else str(seconds)
    clock = f"{hours}H" * bool(hours) + f"{minutes}M" * bool(minutes) + f"{second}S" * bool(seconds or fraction)
    text = "P" + f"{days}D" * bool(days) + f"T{clock}" * bool(clock)
    return text if text != "P" else "PT0S"


def _key(value: Any) -> str:
    """Render a MAP key as the text Kuzu prints for it, which is what the TypeScript driver returns.

    @param value (Any): the key.
    @return (str): the key text.
    """
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, float):
        return f"{value:f}"
    if isinstance(value, datetime):
        utc = value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
        head, _, fraction = str(utc).partition(".")
        return head + "." * bool(fraction.rstrip("0")) + fraction.rstrip("0") + "+00" * bool(value.tzinfo)
    return str(value)


def normalize(value: Any) -> Any:
    """Convert a Kuzu result value to the JSON-ready value the TypeScript store returns for the same column.

    @param value (Any): a raw value from a Kuzu result row.
    @return (Any): numbers when exact, else strings; ISO text for dates, timestamps and intervals; hex for blobs.
    """
    if isinstance(value, dict):
        return {k if isinstance(k, str) else _key(k): normalize(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [normalize(v) for v in value]
    if isinstance(value, bytes | bytearray):
        return value.hex()
    if isinstance(value, bool) or value is None or isinstance(value, str | float):
        return value
    if isinstance(value, int):
        return _integer(value)
    if isinstance(value, Decimal):
        return _decimal(value)
    if isinstance(value, datetime):
        return json_iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, timedelta):
        return _duration(value)
    return str(value)
