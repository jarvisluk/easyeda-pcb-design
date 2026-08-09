#!/usr/bin/env python3
"""Validate cross-field consistency in a PCB layout constraint record.

This checker closes the PCB placement-entry gate only. It never authorizes
fabrication and it deliberately keeps prototype-only performance evidence
separate from geometric integration feasibility.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


PLACEMENT_STATES = {"FEASIBLE", "INFEASIBLE", "UNRESOLVED", "STALE"}
DISPOSITIONS = {"FOLLOW", "PROPOSE_REVISION", "UNRESOLVED", "STALE"}
LAYER_STATES = {"SELECTABLE", "CONDITIONAL", "INFEASIBLE", "UNRESOLVED", "STALE"}
ENTRY_STATES = {"CLEARED_FOR_PLACEMENT", "BLOCKED", "UNRESOLVED", "STALE"}
SPECIALIZED_STATES = ENTRY_STATES | {"NOT_APPLICABLE"}
CONFLICT_STATES = {"RESOLVED", "BLOCKED", "UNRESOLVED", "STALE"}


def _nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _artifact_exists(value: Any, base_dir: Path | None) -> bool:
    if not _nonempty(value):
        return False
    if base_dir is None:
        return True
    artifact = Path(value)
    if not artifact.is_absolute():
        artifact = base_dir / artifact
    return artifact.is_file()


def _enum(
    errors: list[str], field: str, value: Any, allowed: set[str]
) -> str | None:
    if value not in allowed:
        errors.append(f"{field} must be one of {sorted(allowed)}; got {value!r}")
        return None
    return str(value)


def validate_constraint_record(
    record: dict[str, Any], base_dir: Path | None = None
) -> dict[str, Any]:
    """Return a deterministic consistency report for one constraint record."""

    errors: list[str] = []
    warnings: list[str] = []
    blocked: list[str] = []
    stale: list[str] = []
    unresolved: list[str] = []
    release_evidence_pending: list[str] = []

    if not _nonempty(record.get("revision")):
        errors.append("revision must be a non-empty exact PCB revision or fingerprint")

    entry = record.get("pcbEntryGate")
    if not isinstance(entry, dict):
        errors.append("pcbEntryGate must be an object")
        entry = {}
    claimed_gate = _enum(errors, "pcbEntryGate.status", entry.get("status"), ENTRY_STATES)

    placement = record.get("placementFeasibility")
    if not isinstance(placement, dict):
        errors.append("placementFeasibility must be an object")
        placement = {}
    placement_state = _enum(
        errors,
        "placementFeasibility.status",
        placement.get("status"),
        PLACEMENT_STATES,
    )
    disposition = _enum(
        errors,
        "placementFeasibility.disposition",
        placement.get("disposition"),
        DISPOSITIONS,
    )
    placement_conflicts = placement.get("conflicts")
    if not isinstance(placement_conflicts, list):
        errors.append("placementFeasibility.conflicts must be an array")
        placement_conflicts = []

    required_mapping = {
        "FEASIBLE": "FOLLOW",
        "INFEASIBLE": "PROPOSE_REVISION",
        "UNRESOLVED": "UNRESOLVED",
        "STALE": "STALE",
    }
    if placement_state and disposition != required_mapping[placement_state]:
        errors.append(
            "placementFeasibility.status and disposition disagree: "
            f"{placement_state} requires {required_mapping[placement_state]}"
        )

    if placement_state == "FEASIBLE":
        if placement_conflicts:
            errors.append("FEASIBLE placement must not retain unresolved conflicts")
        proof = placement.get("proofArtifact")
        if not _artifact_exists(proof, base_dir):
            errors.append(
                "FEASIBLE placement requires an existing placementFeasibility.proofArtifact"
            )
    elif placement_state == "INFEASIBLE":
        blocked.append("placementFeasibility.status is INFEASIBLE")
        if not placement_conflicts:
            errors.append("INFEASIBLE placement must name at least one conflict")
    elif placement_state == "STALE":
        stale.append("placementFeasibility.status is STALE")
    elif placement_state == "UNRESOLVED":
        unresolved.append("placementFeasibility.status is UNRESOLVED")

    specialized = placement.get("specializedGates", {})
    if not isinstance(specialized, dict):
        errors.append("placementFeasibility.specializedGates must be an object")
        specialized = {}
    if "onboardAntenna" not in specialized:
        errors.append(
            "placementFeasibility.specializedGates.onboardAntenna is required; "
            "set applicable false when no onboard antenna is present"
        )
    for name, gate in sorted(specialized.items()):
        prefix = f"placementFeasibility.specializedGates.{name}"
        if not isinstance(gate, dict):
            errors.append(f"{prefix} must be an object")
            continue
        applicable = gate.get("applicable")
        if not isinstance(applicable, bool):
            errors.append(f"{prefix}.applicable must be true or false")
            continue
        planning_state = _enum(
            errors, f"{prefix}.planningStatus", gate.get("planningStatus"), SPECIALIZED_STATES
        )
        if applicable:
            if planning_state == "NOT_APPLICABLE":
                errors.append(f"{prefix} is applicable but marked NOT_APPLICABLE")
            elif planning_state == "BLOCKED":
                blocked.append(f"{prefix}.planningStatus is BLOCKED")
            elif planning_state == "STALE":
                stale.append(f"{prefix}.planningStatus is STALE")
            elif planning_state == "UNRESOLVED":
                unresolved.append(f"{prefix}.planningStatus is UNRESOLVED")
            elif planning_state == "CLEARED_FOR_PLACEMENT":
                artifact = gate.get("constraintRecord")
                if not _artifact_exists(artifact, base_dir):
                    errors.append(
                        f"{prefix}.constraintRecord must name an existing artifact when cleared"
                    )
        elif planning_state != "NOT_APPLICABLE":
            errors.append(f"{prefix} is not applicable and must be NOT_APPLICABLE")

        performance = gate.get("performanceStatus")
        if not _nonempty(performance):
            errors.append(f"{prefix}.performanceStatus must be a non-empty string")
        elif applicable and performance == "NOT_APPLICABLE":
            errors.append(f"{prefix} is applicable but performanceStatus is NOT_APPLICABLE")
        elif not applicable and performance != "NOT_APPLICABLE":
            errors.append(f"{prefix} is not applicable and performanceStatus must be NOT_APPLICABLE")
        elif applicable and (
            str(performance).startswith("UNVERIFIED") or performance == "STALE"
        ):
            pending = f"{prefix}.performanceStatus is {performance}"
            release_evidence_pending.append(pending)
            warnings.append(
                f"{pending}; this does not block placement but remains open for fabrication review"
            )

    layer = record.get("layerCountDecision")
    if not isinstance(layer, dict):
        errors.append("layerCountDecision must be an object")
        layer = {}
    layer_state = _enum(
        errors, "layerCountDecision.status", layer.get("status"), LAYER_STATES
    )
    if layer_state == "SELECTABLE":
        count = layer.get("recommendedLayerCount")
        if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
            errors.append(
                "SELECTABLE layerCountDecision requires a positive integer recommendedLayerCount"
            )
        artifact = layer.get("candidateComparisonArtifact")
        if not _artifact_exists(artifact, base_dir):
            errors.append(
                "SELECTABLE layerCountDecision requires an existing candidateComparisonArtifact"
            )
        layers = record.get("layers")
        if not isinstance(layers, list) or not layers:
            errors.append("SELECTABLE layerCountDecision requires a non-empty layers table")
        elif isinstance(count, int) and not isinstance(count, bool) and len(layers) != count:
            errors.append(
                "layers table length must equal layerCountDecision.recommendedLayerCount"
            )
        if isinstance(layers, list):
            layer_names: set[str] = set()
            for index, item in enumerate(layers):
                prefix = f"layers[{index}]"
                if not isinstance(item, dict):
                    errors.append(f"{prefix} must be an object")
                    continue
                name = item.get("name")
                if not _nonempty(name):
                    errors.append(f"{prefix}.name must be a non-empty string")
                elif name in layer_names:
                    errors.append(f"{prefix}.name duplicates {name!r}")
                else:
                    layer_names.add(str(name))
                if not _nonempty(item.get("role")):
                    errors.append(f"{prefix}.role must be a non-empty string")
    elif layer_state == "INFEASIBLE":
        blocked.append("layerCountDecision.status is INFEASIBLE")
    elif layer_state == "STALE":
        stale.append("layerCountDecision.status is STALE")
    elif layer_state in {"CONDITIONAL", "UNRESOLVED"}:
        unresolved.append(f"layerCountDecision.status is {layer_state}")

    conflicts = record.get("crossConstraintConflicts")
    if not isinstance(conflicts, list):
        errors.append("crossConstraintConflicts must be an array")
        conflicts = []
    seen_ids: set[str] = set()
    for index, conflict in enumerate(conflicts):
        prefix = f"crossConstraintConflicts[{index}]"
        if not isinstance(conflict, dict):
            errors.append(f"{prefix} must be an object")
            continue
        conflict_id = conflict.get("id")
        if not _nonempty(conflict_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif conflict_id in seen_ids:
            errors.append(f"{prefix}.id duplicates {conflict_id!r}")
        else:
            seen_ids.add(str(conflict_id))
        for field in ("resources", "constraints"):
            values = conflict.get(field)
            if not isinstance(values, list) or not values:
                errors.append(f"{prefix}.{field} must be a non-empty array")
        state = _enum(errors, f"{prefix}.status", conflict.get("status"), CONFLICT_STATES)
        if state == "RESOLVED":
            if not _nonempty(conflict.get("resolution")):
                errors.append(f"{prefix}.resolution is required when RESOLVED")
            if not _artifact_exists(conflict.get("evidenceArtifact"), base_dir):
                errors.append(
                    f"{prefix}.evidenceArtifact must name an existing artifact when RESOLVED"
                )
        elif state == "BLOCKED":
            blocked.append(f"{prefix}.status is BLOCKED")
        elif state == "STALE":
            stale.append(f"{prefix}.status is STALE")
        elif state == "UNRESOLVED":
            unresolved.append(f"{prefix}.status is UNRESOLVED")

    if errors:
        derived_gate = "BLOCKED"
    elif blocked:
        derived_gate = "BLOCKED"
    elif stale:
        derived_gate = "STALE"
    elif unresolved:
        derived_gate = "UNRESOLVED"
    else:
        derived_gate = "CLEARED_FOR_PLACEMENT"

    if claimed_gate and claimed_gate != derived_gate:
        errors.append(
            f"pcbEntryGate.status claims {claimed_gate}, but child states derive {derived_gate}"
        )

    return {
        "kind": "easyeda-constraint-consistency",
        "revision": record.get("revision"),
        "consistent": not errors,
        "claimedGateStatus": claimed_gate,
        "gateStatus": derived_gate,
        "fabricationRelease": False,
        "releaseEvidencePending": release_evidence_pending,
        "errors": errors,
        "warnings": warnings,
        "blockedBy": blocked,
        "staleBy": stale,
        "unresolvedBy": unresolved,
    }


def _exit_code(report: dict[str, Any]) -> int:
    if report["errors"] or report["gateStatus"] == "BLOCKED":
        return 2
    if report["gateStatus"] == "UNRESOLVED":
        return 3
    if report["gateStatus"] == "STALE":
        return 4
    return 0


def _base_record() -> dict[str, Any]:
    return {
        "revision": "self-test-revision",
        "pcbEntryGate": {"status": "CLEARED_FOR_PLACEMENT"},
        "placementFeasibility": {
            "status": "FEASIBLE",
            "proofArtifact": "floorplan.json",
            "conflicts": [],
            "disposition": "FOLLOW",
            "specializedGates": {
                "onboardAntenna": {
                    "applicable": False,
                    "constraintRecord": None,
                    "planningStatus": "NOT_APPLICABLE",
                    "performanceStatus": "NOT_APPLICABLE",
                }
            },
        },
        "layerCountDecision": {
            "status": "SELECTABLE",
            "recommendedLayerCount": 4,
            "candidateComparisonArtifact": "stackup-candidates.json",
        },
        "layers": [
            {"name": "Top Layer", "role": "primary-signal"},
            {"name": "Inner Layer 1", "role": "continuous-reference"},
            {"name": "Inner Layer 2", "role": "power-distribution"},
            {"name": "Bottom Layer", "role": "limited-signal"},
        ],
        "crossConstraintConflicts": [],
    }


def _self_test() -> int:
    cases: list[tuple[str, dict[str, Any], str, int, bool]] = []
    cases.append(("cleared", _base_record(), "CLEARED_FOR_PLACEMENT", 0, True))

    contradictory = copy.deepcopy(_base_record())
    contradictory["placementFeasibility"]["status"] = "UNRESOLVED"
    cases.append(("contradictory", contradictory, "BLOCKED", 2, False))

    missing_performance = copy.deepcopy(_base_record())
    del missing_performance["placementFeasibility"]["specializedGates"]["onboardAntenna"][
        "performanceStatus"
    ]
    cases.append(("missing-performance-status", missing_performance, "BLOCKED", 2, False))

    unresolved = copy.deepcopy(_base_record())
    unresolved["pcbEntryGate"]["status"] = "UNRESOLVED"
    unresolved["placementFeasibility"].update(
        {"status": "UNRESOLVED", "disposition": "UNRESOLVED", "proofArtifact": None}
    )
    cases.append(("unresolved", unresolved, "UNRESOLVED", 3, True))

    blocked = copy.deepcopy(_base_record())
    blocked["pcbEntryGate"]["status"] = "BLOCKED"
    blocked["crossConstraintConflicts"] = [
        {
            "id": "EDGE_RESOURCE",
            "resources": ["north board edge"],
            "constraints": ["antenna clearance", "connector access"],
            "status": "BLOCKED",
        }
    ]
    cases.append(("blocked", blocked, "BLOCKED", 2, True))

    stale = copy.deepcopy(_base_record())
    stale["pcbEntryGate"]["status"] = "STALE"
    stale["layerCountDecision"]["status"] = "STALE"
    cases.append(("stale", stale, "STALE", 4, True))

    antenna_pending = copy.deepcopy(_base_record())
    antenna_pending["placementFeasibility"]["specializedGates"]["onboardAntenna"] = {
        "applicable": True,
        "constraintRecord": "antenna-constraints.json",
        "planningStatus": "CLEARED_FOR_PLACEMENT",
        "performanceStatus": "UNVERIFIED_PENDING_PROTOTYPE_TEST",
    }
    cases.append(
        ("antenna-performance-pending", antenna_pending, "CLEARED_FOR_PLACEMENT", 0, True)
    )

    for name, record, expected_gate, expected_code, expected_consistent in cases:
        report = validate_constraint_record(record, base_dir=None)
        actual = (report["gateStatus"], _exit_code(report), report["consistent"])
        expected = (expected_gate, expected_code, expected_consistent)
        if actual != expected:
            print(f"self-test {name} failed: expected {expected}, got {actual}", file=sys.stderr)
            print(json.dumps(report, indent=2, ensure_ascii=False), file=sys.stderr)
            return 1

    missing_artifact = validate_constraint_record(
        _base_record(), base_dir=Path("/__easyeda_constraint_lint_missing_artifacts__")
    )
    if missing_artifact["consistent"] or missing_artifact["gateStatus"] != "BLOCKED":
        print("self-test missing-artifact failed", file=sys.stderr)
        print(json.dumps(missing_artifact, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1
    print(f"easyeda_constraint_lint self-test passed ({len(cases)} cases)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate the aggregate PCB placement-entry constraint gate"
    )
    parser.add_argument("--record", type=Path, help="path to layout-constraints.json")
    parser.add_argument("--output", type=Path, help="optional JSON report path")
    parser.add_argument("--self-test", action="store_true", help="run deterministic tests")
    args = parser.parse_args()

    if args.self_test:
        return _self_test()
    if args.record is None:
        parser.error("--record is required unless --self-test is used")

    try:
        record_bytes = args.record.read_bytes()
        record = json.loads(record_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"failed to read constraint record: {exc}", file=sys.stderr)
        return 2
    if not isinstance(record, dict):
        print("constraint record root must be an object", file=sys.stderr)
        return 2

    report = validate_constraint_record(record, base_dir=args.record.resolve().parent)
    report["constraintRecordFingerprint"] = (
        "sha256:" + hashlib.sha256(record_bytes).hexdigest()
    )
    rendered = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        if args.output.resolve() == args.record.resolve():
            print("refusing to overwrite the input constraint record", file=sys.stderr)
            return 2
        try:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as handle:
                handle.write(rendered)
        except FileExistsError:
            print(f"refusing to overwrite existing evidence: {args.output}", file=sys.stderr)
            return 2
        except OSError as exc:
            print(f"failed to write consistency evidence: {exc}", file=sys.stderr)
            return 2
    else:
        sys.stdout.write(rendered)
    return _exit_code(report)


if __name__ == "__main__":
    raise SystemExit(main())
