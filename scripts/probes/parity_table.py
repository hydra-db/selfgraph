#!/usr/bin/env python3
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from _harness import REPO, fresh_graph

CASES = [
    ["null_value", "prop_value", None],
    ["int_2p53_minus_1", "prop_value", 9007199254740991],
    ["int_2p53", "prop_value", 9007199254740992],
    ["int_2p53_plus_1", "prop_value", 9007199254740993],
    ["float_1e21", "prop_value", 1e21],
    ["float_neg_1e20", "prop_value", -1e20],
    ["astral_value", "prop_value", "a\U0001f600b"],
    ["bom_value", "prop_value", "\ufeffhi"],
    ["dollar_amp_value", "extid_value", "$&"],
    ["proto_key", "extid_key", "__proto__"],
    ["nul_key", "prop_key", "a\u0000b"],
    ["bom_key", "extid_key", "\ufeffk"],
    ["nfkc_name", "name", "Ångström"],
    ["nfkc_lookalike_name", "name", "Ångström"],
    ["bom_astral_name", "name", "\ufeff\U0001f600X"],
    ["year0000_event_time", "event_time", "0000-01-01T00:00:00+01:00"],
]


def _mask(message):
    """Replace the run specific namespace in an error message.

    @param message (str): the error message.
    @return (str): the message with the namespace masked.
    """
    return re.sub(r"in namespace '[^']*'", "in namespace '<ns>'", message)


async def _run_case(op, value):
    """Run one edge input through the Python SDK on an isolated Kuzu graph.

    @param op (str): the operation name.
    @param value (object): the edge input.
    @return (object): the stored output, or an error descriptor.
    """
    from selfgraph import ids
    from selfgraph._serde import json_iso
    from selfgraph.errors import SelfGraphError
    from selfgraph.runtime import to_jsonable

    graph = fresh_graph()
    await graph.initialize()
    try:
        if op == "name":
            entity = await graph.entities.create(value, "Person")
            return {"id": ids.entity_id("Person", value), "name": entity.name}
        if op == "event_time":
            await graph.entities.create("A", "Person", id="t:a")
            await graph.entities.create("B", "Person", id="t:b")
            rel = await graph.relations.create("t:a", "KNOWS", "t:b", event_time=value)
            return {"event_time": json_iso(rel.event_time)}
        name = "X"
        if op == "prop_value":
            entity = await graph.entities.create(name, "Person", properties={"p": value})
            return {"value": to_jsonable(entity.properties.get("p"))}
        if op == "extid_value":
            entity = await graph.entities.create(name, "Person", external_ids={"k": value})
            return {"value": entity.external_ids.get("k")}
        if op == "prop_key":
            entity = await graph.entities.create(name, "Person", properties={value: "v"})
            return {"keys": sorted(entity.properties.keys())}
        if op == "extid_key":
            entity = await graph.entities.create(name, "Person", external_ids={value: "v"})
            return {"keys": sorted(entity.external_ids.keys())}
        return {"error_code": "unknown_op", "error_field": None, "message": op}
    except SelfGraphError as exc:
        return {"error_code": exc.code, "error_field": exc.field, "message": _mask(str(exc))}
    finally:
        await graph.close()


async def run_python():
    """Run every case through the Python SDK.

    @return (dict): case id to its output.
    """
    out = {}
    for case_id, op, value in CASES:
        out[case_id] = await _run_case(op, value)
    return out


def run_typescript():
    """Run the TypeScript side of the parity table through vitest and read its output.

    @return (dict): case id to its output.
    """
    out_file = os.path.join(tempfile.mkdtemp(prefix="parity-ts-"), "ts.json")
    env = dict(os.environ)
    env["PARITY_OUT"] = out_file
    env["SELFGRAPH_TEST_STORES"] = "kuzu"
    proc = subprocess.run(
        [
            shutil.which("npx") or "npx",
            "vitest",
            "run",
            "--config",
            "vitest.probe.config.ts",
            "scripts/probes/parity_table.probe.ts",
        ],
        cwd=os.path.join(REPO, "typescript"),
        env=env,
        capture_output=True,
        text=True,
    )
    if not os.path.exists(out_file):
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit("parity probe: the TypeScript side did not produce output")
    with open(out_file, encoding="utf-8") as handle:
        return json.load(handle)


def _canon(value):
    """Serialize a value to a canonical JSON string for byte comparison.

    @param value (object): the value.
    @return (str): the canonical JSON.
    """
    return json.dumps(value, sort_keys=True, ensure_ascii=True)


def _compare(py_val, ts_val):
    """Compare two case outputs behaviourally.

    An error is compared by code and field, since its message echoes the input, and an input such as 2**53 + 1
    cannot be written identically in both languages. A stored value is compared byte for byte.

    @param py_val (object): the Python output.
    @param ts_val (object): the TypeScript output.
    @return (tuple[bool, str | None]): whether the behaviour agrees, and a note when only the message differs.
    """
    py_err = isinstance(py_val, dict) and "error_code" in py_val
    ts_err = isinstance(ts_val, dict) and "error_code" in ts_val
    if py_err and ts_err:
        same = py_val.get("error_code") == ts_val.get("error_code") and py_val.get("error_field") == ts_val.get(
            "error_field"
        )
        note = None
        if same and py_val.get("message") != ts_val.get("message"):
            note = "same code, message echoes the input differently"
        return same, note
    return _canon(py_val) == _canon(ts_val), None


def main(argv=None):
    """Diff the parity table between the Python and TypeScript SDKs.

    @param argv (list[str] | None): command line arguments.
    @return (int): 0 when both sides agree, 1 otherwise.
    """
    py = asyncio.run(run_python())
    if argv and "--emit" in argv:
        print(json.dumps(py, ensure_ascii=True, indent=2))
        return 0
    ts = run_typescript()
    mismatches = []
    for case_id in [c[0] for c in CASES]:
        equal, note = _compare(py.get(case_id), ts.get(case_id))
        status = "ok  " if equal else "DIFF"
        print(f"[{status}] {case_id}" + (f"   ({note})" if note else ""))
        print(f"       py: {_canon(py.get(case_id))}")
        print(f"       ts: {_canon(ts.get(case_id))}")
        if not equal:
            mismatches.append(case_id)
    print()
    if mismatches:
        print(f"parity probe: FAIL, {len(mismatches)} case(s) diverge: {', '.join(mismatches)}")
        return 1
    print(f"parity probe: all {len(CASES)} cases agree")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
