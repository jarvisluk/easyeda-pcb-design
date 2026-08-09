#!/usr/bin/env python3
"""Read-only regression audit for EasyEDA Gerber/BOM/PnP API exports.

This verifies package structure and machine-readable consistency. It never
authorizes fabrication, ordering, or assembly release.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
import tempfile
import zipfile
from pathlib import Path


DECISION_PASS = "PASS WITH DOCUMENTED ASSUMPTIONS/EXCEPTIONS"
DECISION_FAIL = "FAIL"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gerber")
    parser.add_argument("--bom")
    parser.add_argument("--pnp")
    parser.add_argument("--pcb-info")
    parser.add_argument("--expected-designators", default="")
    parser.add_argument("--allowed-bom-omission", default="")
    parser.add_argument("--expected-copper-layers", type=int, default=2)
    parser.add_argument("--output")
    parser.add_argument("--self-test", action="store_true")
    options = parser.parse_args(argv)
    if not options.self_test:
        for key in ("gerber", "bom", "pnp", "output"):
            if not getattr(options, key):
                parser.error(f"--{key.replace('_', '-')} is required")
    return options


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def split_set(value: str) -> set[str]:
    return {item.strip() for item in value.split(",") if item.strip()}


def read_table(path: Path) -> tuple[list[str], list[dict[str, str]], str]:
    raw = path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
    elif raw.startswith(b"\xef\xbb\xbf"):
        encoding = "utf-8-sig"
    else:
        encoding = "utf-8"
    text = raw.decode(encoding)
    first = text.splitlines()[0] if text.splitlines() else ""
    delimiter = "\t" if first.count("\t") >= first.count(",") else ","
    reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
    return list(reader.fieldnames or []), list(reader), encoding


def gerber_outline(text: str) -> dict[str, object]:
    fmt = re.search(r"%FSLAX(\d)(\d)Y\d\d\*%", text)
    decimals = int(fmt.group(2)) if fmt else 6
    scale = 10**decimals
    points: list[tuple[float, float, str]] = []
    current_x = current_y = None
    for line in text.splitlines():
        match = re.search(r"X(-?\d+)Y(-?\d+)D0([12])\*", line)
        if not match:
            continue
        current_x = int(match.group(1)) / scale
        current_y = int(match.group(2)) / scale
        points.append((current_x, current_y, match.group(3)))
    if not points:
        return {"present": False}
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    first_move = next((point for point in points if point[2] == "2"), points[0])
    last_draw = next(
        (point for point in reversed(points) if point[2] == "1"), points[-1]
    )
    return {
        "present": True,
        "unit": "mm" if "%MOMM*%" in text else "unknown",
        "coordinateDecimals": decimals,
        "drawPointCount": sum(point[2] == "1" for point in points),
        "closed": math.isclose(first_move[0], last_draw[0], abs_tol=1e-9)
        and math.isclose(first_move[1], last_draw[1], abs_tol=1e-9),
        "boundsMm": {
            "minX": min(xs),
            "minY": min(ys),
            "maxX": max(xs),
            "maxY": max(ys),
            "width": max(xs) - min(xs),
            "height": max(ys) - min(ys),
        },
    }


def drill_summary(text: str) -> dict[str, object]:
    tools = {
        match.group(1): float(match.group(2))
        for match in re.finditer(r"^T(\d+)C([0-9.]+)", text, re.MULTILINE)
    }
    coordinate_lines = [
        line
        for line in text.splitlines()
        if re.match(r"^X-?[0-9.]+Y-?[0-9.]+", line)
    ]
    return {
        "type": "NPTH" if ";TYPE=NON_PLATED" in text else "PTH",
        "unit": "mm" if "METRIC" in text else "unknown",
        "toolsMm": tools,
        "coordinateLineCount": len(coordinate_lines),
        "slotCount": sum("G85" in line for line in coordinate_lines),
        "terminated": "M30" in text,
    }


def audit(options: argparse.Namespace) -> dict[str, object]:
    gerber_path = Path(options.gerber).resolve()
    bom_path = Path(options.bom).resolve()
    pnp_path = Path(options.pnp).resolve()
    pcb_info_path = Path(options.pcb_info).resolve() if options.pcb_info else None
    failures: list[str] = []
    warnings: list[str] = []

    required_suffixes = {
        ".GTL",
        ".GBL",
        ".GTO",
        ".GTS",
        ".GBS",
        ".GTP",
        ".GKO",
    }
    with zipfile.ZipFile(gerber_path) as archive:
        bad_entries = archive.testzip()
        names = archive.namelist()
        suffixes = {Path(name).suffix.upper() for name in names}
        missing_suffixes = sorted(required_suffixes - suffixes)
        inner_layers = sorted(
            name for name in names if re.search(r"InnerLayer\d+\.G\d+$", name)
        )
        outline_name = next((name for name in names if name.endswith(".GKO")), None)
        outline = (
            gerber_outline(archive.read(outline_name).decode("ascii", "replace"))
            if outline_name
            else {"present": False}
        )
        drill_names = [name for name in names if name.upper().endswith(".DRL")]
        drills = {
            name: drill_summary(archive.read(name).decode("ascii", "replace"))
            for name in drill_names
        }

    if bad_entries:
        failures.append(f"Gerber ZIP CRC failed at {bad_entries}")
    if missing_suffixes:
        failures.append(f"Gerber package lacks required layers: {missing_suffixes}")
    if len(inner_layers) != max(0, options.expected_copper_layers - 2):
        failures.append(
            f"expected {options.expected_copper_layers - 2} inner copper layers, found {len(inner_layers)}"
        )
    if not outline.get("present") or not outline.get("closed"):
        failures.append("board-outline Gerber is absent or not closed")
    if not any(summary["type"] == "PTH" for summary in drills.values()):
        failures.append("no plated drill file found")
    if not any(summary["type"] == "NPTH" for summary in drills.values()):
        failures.append("no non-plated drill file found")
    if any(not summary["terminated"] for summary in drills.values()):
        failures.append("one or more drill files lack M30 termination")

    bom_fields, bom_rows, bom_encoding = read_table(bom_path)
    pnp_fields, pnp_rows, pnp_encoding = read_table(pnp_path)
    bom_designators: set[str] = set()
    bom_quantity = 0
    for row in bom_rows:
        bom_designators.update(split_set(row.get("Designator", "")))
        try:
            bom_quantity += int(row.get("Quantity", "0"))
        except ValueError:
            failures.append(f"invalid BOM quantity: {row.get('Quantity')!r}")
    pnp_designators = {row.get("Designator", "").strip('" ') for row in pnp_rows}
    pnp_designators.discard("")
    expected = split_set(options.expected_designators)
    allowed_omissions = split_set(options.allowed_bom_omission)

    if expected:
        missing_pnp = sorted(expected - pnp_designators)
        extra_pnp = sorted(pnp_designators - expected)
        if missing_pnp or extra_pnp:
            failures.append(
                f"PnP designators differ: missing={missing_pnp}, extra={extra_pnp}"
            )
        missing_bom = expected - bom_designators
        unexpected_missing_bom = sorted(missing_bom - allowed_omissions)
        stale_allowed = sorted(allowed_omissions - missing_bom)
        if unexpected_missing_bom:
            failures.append(
                f"BOM omits designators without disposition: {unexpected_missing_bom}"
            )
        if stale_allowed:
            failures.append(f"allowed BOM omissions are stale: {stale_allowed}")
        if missing_bom:
            warnings.append(
                f"BOM intentionally omits {sorted(missing_bom)}; retain DNP/manual-fit disposition"
            )

    invalid_pnp_rows = []
    for row in pnp_rows:
        layer = row.get("Layer", "")
        rotation = row.get("Rotation", "")
        mid_x = row.get("Mid X", "").replace("mm", "")
        mid_y = row.get("Mid Y", "").replace("mm", "")
        try:
            numeric = [float(rotation), float(mid_x), float(mid_y)]
        except ValueError:
            numeric = [math.nan]
        if layer not in {"T", "B"} or not all(math.isfinite(item) for item in numeric):
            invalid_pnp_rows.append(row.get("Designator", "<unknown>"))
    if invalid_pnp_rows:
        failures.append(f"invalid PnP layer/coordinate/rotation rows: {invalid_pnp_rows}")

    pcb_info = None
    if pcb_info_path:
        pcb_info = {
            "path": str(pcb_info_path),
            "sha256": sha256(pcb_info_path),
            "text": pcb_info_path.read_text("utf-8", errors="replace"),
        }
        if "0mil x 0mil" in pcb_info["text"] and outline.get("present"):
            warnings.append(
                "EasyEDA PCB-info reports 0mil x 0mil, contradicted by the closed Gerber outline; Gerber bounds are authoritative"
            )

    return {
        "schemaVersion": 1,
        "kind": "easyeda-manufacturing-output-audit",
        "decision": DECISION_FAIL if failures else DECISION_PASS,
        "fabricationRelease": False,
        "manufacturingOutputsReviewed": False,
        "notAFabricationRelease": (
            "This machine audit is not human fabrication or assembly release. "
            "It does not order boards or attest visual/mechanical acceptability."
        ),
        "files": {
            "gerber": {"path": str(gerber_path), "sha256": sha256(gerber_path)},
            "bom": {"path": str(bom_path), "sha256": sha256(bom_path)},
            "pnp": {"path": str(pnp_path), "sha256": sha256(pnp_path)},
            "pcbInfo": pcb_info,
        },
        "checks": {
            "gerberZipCrc": bad_entries is None,
            "entries": names,
            "missingRequiredLayerSuffixes": missing_suffixes,
            "innerCopperLayers": inner_layers,
            "outline": outline,
            "drills": drills,
            "bom": {
                "encoding": bom_encoding,
                "fields": bom_fields,
                "rowCount": len(bom_rows),
                "quantityTotal": bom_quantity,
                "designators": sorted(bom_designators),
            },
            "pnp": {
                "encoding": pnp_encoding,
                "fields": pnp_fields,
                "rowCount": len(pnp_rows),
                "designators": sorted(pnp_designators),
                "topCount": sum(row.get("Layer") == "T" for row in pnp_rows),
                "bottomCount": sum(row.get("Layer") == "B" for row in pnp_rows),
            },
            "expectedDesignators": sorted(expected),
            "allowedBomOmissions": sorted(allowed_omissions),
        },
        "failures": failures,
        "warnings": warnings,
        "limitations": [
            "Gerber syntax is structurally inspected but not rendered by this script.",
            "BOM supplier availability, substitutions, polarity, and assembly process are not attested.",
            "PnP origin/rotation correctness still requires final visual review.",
            "Impedance and stackup remain fabricator-controlled release inputs.",
        ],
    }


def self_test() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        gerber = root / "gerber.zip"
        bom = root / "bom.csv"
        pnp = root / "pnp.csv"
        with zipfile.ZipFile(gerber, "w") as archive:
            outline = "%FSLAX26Y26*%\n%MOMM*%\nX0Y0D02*\nX1000000Y0D01*\nX1000000Y2000000D01*\nX0Y2000000D01*\nX0Y0D01*\n"
            for name in (
                "Top.GTL",
                "Bottom.GBL",
                "TopSilk.GTO",
                "TopMask.GTS",
                "BottomMask.GBS",
                "TopPaste.GTP",
            ):
                archive.writestr(name, "M02*\n")
            archive.writestr("Outline.GKO", outline)
            archive.writestr("PTH.DRL", ";TYPE=PLATED\nMETRIC\nX1Y1\nM30\n")
            archive.writestr("NPTH.DRL", ";TYPE=NON_PLATED\nMETRIC\nX2Y2\nM30\n")
        bom.write_text("Quantity\tDesignator\n1\tU1\n", encoding="utf-16")
        pnp.write_text(
            "Designator\tMid X\tMid Y\tLayer\tRotation\nU1\t1mm\t2mm\tT\t0\n",
            encoding="utf-16",
        )
        options = parse_args(
            [
                "--gerber",
                str(gerber),
                "--bom",
                str(bom),
                "--pnp",
                str(pnp),
                "--expected-designators",
                "U1",
                "--output",
                str(root / "result.json"),
            ]
        )
        report = audit(options)
        assert report["decision"] == DECISION_PASS, report
        assert report["checks"]["outline"]["closed"] is True
        assert report["checks"]["outline"]["boundsMm"]["width"] == 1


def main(argv: list[str]) -> int:
    options = parse_args(argv)
    if options.self_test:
        self_test()
        print("easyeda manufacturing audit self-test passed")
        return 0
    report = audit(options)
    output = Path(options.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
    except FileExistsError:
        print(f"refusing to overwrite existing output: {output}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 2 if report["decision"] == DECISION_FAIL else 4


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
