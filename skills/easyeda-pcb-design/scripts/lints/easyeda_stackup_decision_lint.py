#!/usr/bin/env python3
"""Validate a PCB layer-count candidate comparison and selected stackup.

The validator proves only that the planning record is internally complete and
consistent. It never authorizes fabrication and it does not replace native DRC,
field solving, fabricator confirmation, or laboratory evidence.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


DECISION_STATES = {"SELECTABLE", "CONDITIONAL", "INFEASIBLE", "UNRESOLVED", "STALE"}
CANDIDATE_STATES = DECISION_STATES
GATE_STATES = {"CLOSED", "FAILED", "OPEN", "STALE"}
GATE_CODES = {
    "ROUTING_CAPACITY",
    "PACKAGE_ESCAPE",
    "REFERENCE_CONTINUITY",
    "POWER_PLANE_AREA",
    "ISOLATION",
    "THERMAL",
    "SHIELDING_EMC",
    "IMPEDANCE_GEOMETRY",
    "VIA_PROCESS",
    "MECHANICAL_BALANCE",
    "MANUFACTURING",
    "DESIGN_MARGIN",
}
DEMAND_PARTITIONS = {
    "routingEscape",
    "referenceReturn",
    "powerIsolationThermalShielding",
    "manufacturingMechanical",
}
LAYER_ROLES = {
    "primary-signal",
    "limited-signal",
    "continuous-reference",
    "power-distribution",
    "mixed-power-reference",
    "forbidden",
}
SIGNAL_ROLES = {"primary-signal", "limited-signal"}
REFERENCE_ROLES = {
    "continuous-reference",
    "power-distribution",
    "mixed-power-reference",
}


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


def _fingerprint(value: Any) -> str:
    rendered = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(rendered).hexdigest()


def _enum(
    errors: list[str], field: str, value: Any, allowed: set[str]
) -> str | None:
    if value not in allowed:
        errors.append(f"{field} must be one of {sorted(allowed)}; got {value!r}")
        return None
    return str(value)


def _string_list(
    errors: list[str], field: str, value: Any, *, nonempty: bool
) -> list[str]:
    if not isinstance(value, list):
        errors.append(f"{field} must be an array")
        return []
    if nonempty and not value:
        errors.append(f"{field} must be a non-empty array")
    result: list[str] = []
    for index, item in enumerate(value):
        if not _nonempty(item):
            errors.append(f"{field}[{index}] must be a non-empty string")
        else:
            result.append(str(item))
    if len(result) != len(set(result)):
        errors.append(f"{field} must not contain duplicates")
    return result


def _validate_partitions(record: dict[str, Any], errors: list[str]) -> None:
    partitions = record.get("demandPartitions")
    if not isinstance(partitions, dict):
        errors.append("demandPartitions must be an object")
        return
    missing = sorted(DEMAND_PARTITIONS - set(partitions))
    extra = sorted(set(partitions) - DEMAND_PARTITIONS)
    if missing:
        errors.append(f"demandPartitions is missing {missing}")
    if extra:
        errors.append(f"demandPartitions has unsupported keys {extra}")
    for name in sorted(DEMAND_PARTITIONS & set(partitions)):
        value = partitions[name]
        prefix = f"demandPartitions.{name}"
        if not isinstance(value, dict):
            errors.append(f"{prefix} must be an object")
            continue
        count = value.get("minimumDedicatedLayers")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            errors.append(f"{prefix}.minimumDedicatedLayers must be an integer >= 0")
        _string_list(errors, f"{prefix}.basis", value.get("basis"), nonempty=True)
        _string_list(
            errors,
            f"{prefix}.sharedRoleConditions",
            value.get("sharedRoleConditions"),
            nonempty=False,
        )


def _validate_layers(
    layers: Any,
    layer_count: int,
    prefix: str,
    errors: list[str],
    base_dir: Path | None,
    candidate: dict[str, Any],
) -> list[dict[str, Any]]:
    if not isinstance(layers, list) or not layers:
        errors.append(f"{prefix}.layerFunctions must be a non-empty array")
        return []
    if len(layers) != layer_count:
        errors.append(
            f"{prefix}.layerFunctions length must equal layerCount ({layer_count})"
        )

    names: dict[str, int] = {}
    normalized: list[dict[str, Any]] = []
    for index, layer in enumerate(layers):
        layer_prefix = f"{prefix}.layerFunctions[{index}]"
        if not isinstance(layer, dict):
            errors.append(f"{layer_prefix} must be an object")
            continue
        name = layer.get("name")
        if not _nonempty(name):
            errors.append(f"{layer_prefix}.name must be a non-empty string")
        elif name in names:
            errors.append(f"{layer_prefix}.name duplicates {name!r}")
        else:
            names[str(name)] = index
        _enum(errors, f"{layer_prefix}.role", layer.get("role"), LAYER_ROLES)
        normalized.append(layer)

    for index, layer in enumerate(layers):
        if not isinstance(layer, dict):
            continue
        layer_prefix = f"{prefix}.layerFunctions[{index}]"
        role = layer.get("role")
        references = layer.get("references")
        if role in SIGNAL_ROLES:
            if not isinstance(references, list) or not 1 <= len(references) <= 2:
                errors.append(f"{layer_prefix}.references must contain one or two references")
                references = []
            reference_targets: set[str] = set()
            for ref_index, reference in enumerate(references):
                ref_prefix = f"{layer_prefix}.references[{ref_index}]"
                if not isinstance(reference, dict):
                    errors.append(f"{ref_prefix} must be an object")
                    continue
                target = reference.get("layer")
                if not _nonempty(target) or target not in names:
                    errors.append(f"{ref_prefix}.layer must name an existing layer")
                    continue
                target_name = str(target)
                if target_name in reference_targets:
                    errors.append(
                        f"{ref_prefix}.layer duplicates reference target {target_name!r}"
                    )
                reference_targets.add(target_name)
                target_index = names[str(target)]
                if abs(target_index - index) != 1:
                    errors.append(f"{ref_prefix}.layer must be adjacent to the signal layer")
                target_layer = layers[target_index]
                target_role = target_layer.get("role") if isinstance(target_layer, dict) else None
                if target_role not in REFERENCE_ROLES:
                    errors.append(
                        f"{ref_prefix}.layer targets role {target_role!r}, not a reference role"
                    )
                if not _nonempty(reference.get("region")):
                    errors.append(f"{ref_prefix}.region must be a non-empty net or region")
                if not _artifact_exists(reference.get("continuityEvidence"), base_dir):
                    errors.append(f"{ref_prefix}.continuityEvidence must name an artifact")
                if target_role == "power-distribution" and not _artifact_exists(
                    reference.get("highFrequencyReturnEvidence"), base_dir
                ):
                    errors.append(
                        f"{ref_prefix}.highFrequencyReturnEvidence is required for a power reference"
                    )
            if role == "limited-signal":
                allow_list = layer.get("netAllowList")
                share = layer.get("maxRoutedLengthSharePct")
                valid_allow_list = isinstance(allow_list, list) and bool(allow_list)
                if valid_allow_list:
                    _string_list(
                        errors,
                        f"{layer_prefix}.netAllowList",
                        allow_list,
                        nonempty=True,
                    )
                valid_share = (
                    isinstance(share, (int, float))
                    and not isinstance(share, bool)
                    and 0 < float(share) <= 100
                )
                if not valid_allow_list and not valid_share:
                    errors.append(
                        f"{layer_prefix} limited-signal requires netAllowList or "
                        "maxRoutedLengthSharePct in (0, 100]"
                    )
        elif references is not None:
            errors.append(f"{layer_prefix}.references is allowed only on signal layers")

        if role in {"continuous-reference", "forbidden"}:
            if layer.get("netAllowList") not in (None, []):
                errors.append(f"{layer_prefix}.netAllowList contradicts role {role}")
            if layer.get("maxRoutedLengthSharePct") is not None:
                errors.append(
                    f"{layer_prefix}.maxRoutedLengthSharePct contradicts role {role}"
                )

    has_adjacent_signal_layers = any(
        isinstance(layers[index], dict)
        and isinstance(layers[index + 1], dict)
        and layers[index].get("role") in SIGNAL_ROLES
        and layers[index + 1].get("role") in SIGNAL_ROLES
        for index in range(max(0, len(layers) - 1))
    )
    if has_adjacent_signal_layers and not _artifact_exists(
        candidate.get("broadsideCouplingEvidence"), base_dir
    ):
        errors.append(
            f"{prefix}.broadsideCouplingEvidence is required for adjacent signal layers"
        )
    return normalized


def _validate_candidate(
    candidate: Any,
    index: int,
    applicable_gates: set[str],
    errors: list[str],
    base_dir: Path | None,
) -> tuple[int | None, str | None, list[dict[str, Any]]]:
    prefix = f"candidates[{index}]"
    if not isinstance(candidate, dict):
        errors.append(f"{prefix} must be an object")
        return None, None, []

    layer_count = candidate.get("layerCount")
    if not isinstance(layer_count, int) or isinstance(layer_count, bool) or layer_count <= 0:
        errors.append(f"{prefix}.layerCount must be a positive integer")
        layer_count = 0
    state = _enum(errors, f"{prefix}.state", candidate.get("state"), CANDIDATE_STATES)
    if not _nonempty(candidate.get("constructionSource")):
        errors.append(f"{prefix}.constructionSource must be a non-empty string")
    if not _nonempty(candidate.get("processCostImpact")):
        errors.append(f"{prefix}.processCostImpact must be a non-empty string")
    if not _artifact_exists(candidate.get("floorplanArtifact"), base_dir):
        errors.append(f"{prefix}.floorplanArtifact must name an artifact")
    canary_artifacts = candidate.get("canaryArtifacts")
    if not isinstance(canary_artifacts, list) or not canary_artifacts:
        errors.append(f"{prefix}.canaryArtifacts must be a non-empty array")
    else:
        for artifact_index, artifact in enumerate(canary_artifacts):
            if not _artifact_exists(artifact, base_dir):
                errors.append(
                    f"{prefix}.canaryArtifacts[{artifact_index}] must name an artifact"
                )

    added_layers_solve = _string_list(
        errors,
        f"{prefix}.addedLayersSolve",
        candidate.get("addedLayersSolve"),
        nonempty=index > 0,
    )
    unsupported_added_purposes = sorted(set(added_layers_solve) - GATE_CODES)
    if unsupported_added_purposes:
        errors.append(
            f"{prefix}.addedLayersSolve contains unsupported purposes "
            f"{unsupported_added_purposes}"
        )
    required_canaries = _string_list(
        errors,
        f"{prefix}.requiredCanaries",
        candidate.get("requiredCanaries"),
        nonempty=False,
    )

    assumptions = candidate.get("openAssumptions")
    decisive_assumption = False
    if not isinstance(assumptions, list):
        errors.append(f"{prefix}.openAssumptions must be an array")
        assumptions = []
    for assumption_index, assumption in enumerate(assumptions):
        assumption_prefix = f"{prefix}.openAssumptions[{assumption_index}]"
        if not isinstance(assumption, dict):
            errors.append(f"{assumption_prefix} must be an object")
            continue
        if not _nonempty(assumption.get("assumption")):
            errors.append(f"{assumption_prefix}.assumption must be a non-empty string")
        decisive = assumption.get("decisive")
        if not isinstance(decisive, bool):
            errors.append(f"{assumption_prefix}.decisive must be true or false")
        elif decisive:
            decisive_assumption = True

    gate_results = candidate.get("gateResults")
    seen_gates: set[str] = set()
    gate_states: list[str] = []
    if not isinstance(gate_results, list) or not gate_results:
        errors.append(f"{prefix}.gateResults must be a non-empty array")
        gate_results = []
    for gate_index, result in enumerate(gate_results):
        gate_prefix = f"{prefix}.gateResults[{gate_index}]"
        if not isinstance(result, dict):
            errors.append(f"{gate_prefix} must be an object")
            continue
        gate = _enum(errors, f"{gate_prefix}.gate", result.get("gate"), GATE_CODES)
        gate_state = _enum(
            errors, f"{gate_prefix}.status", result.get("status"), GATE_STATES
        )
        if gate:
            if gate in seen_gates:
                errors.append(f"{gate_prefix}.gate duplicates {gate}")
            seen_gates.add(gate)
        if gate_state:
            gate_states.append(gate_state)
        if not _nonempty(result.get("reason")):
            errors.append(f"{gate_prefix}.reason must be a non-empty string")
        if gate_state in {"CLOSED", "FAILED", "STALE"} and not _artifact_exists(
            result.get("evidence"), base_dir
        ):
            errors.append(f"{gate_prefix}.evidence must name an artifact")
        if gate_state == "FAILED" and not _nonempty(result.get("minimalRemedy")):
            errors.append(f"{gate_prefix}.minimalRemedy is required when FAILED")
        if gate_state == "OPEN" and not _nonempty(result.get("missingEvidence")):
            errors.append(f"{gate_prefix}.missingEvidence is required when OPEN")

    missing_gates = sorted(applicable_gates - seen_gates)
    extra_gates = sorted(seen_gates - applicable_gates)
    if missing_gates:
        errors.append(f"{prefix}.gateResults is missing applicable gates {missing_gates}")
    if extra_gates:
        errors.append(f"{prefix}.gateResults contains undeclared gates {extra_gates}")

    if state == "SELECTABLE":
        if any(gate_state in {"FAILED", "OPEN", "STALE"} for gate_state in gate_states):
            errors.append(f"{prefix} SELECTABLE candidate cannot have failed/open/stale gates")
        if required_canaries:
            errors.append(f"{prefix} SELECTABLE candidate cannot retain requiredCanaries")
        if decisive_assumption:
            errors.append(f"{prefix} SELECTABLE candidate cannot retain a decisive assumption")
    elif state == "CONDITIONAL":
        if "OPEN" not in gate_states and not decisive_assumption:
            errors.append(f"{prefix} CONDITIONAL candidate requires an open gate or assumption")
        if not required_canaries:
            errors.append(f"{prefix} CONDITIONAL candidate requires requiredCanaries")
    elif state == "INFEASIBLE" and "FAILED" not in gate_states:
        errors.append(f"{prefix} INFEASIBLE candidate requires a failed gate")
    elif state == "UNRESOLVED":
        if "OPEN" not in gate_states and not decisive_assumption:
            errors.append(f"{prefix} UNRESOLVED candidate requires an open gate or assumption")
    elif state == "STALE" and "STALE" not in gate_states:
        errors.append(f"{prefix} STALE candidate requires a stale gate")

    layers = _validate_layers(
        candidate.get("layerFunctions"),
        layer_count,
        prefix,
        errors,
        base_dir,
        candidate,
    )
    return layer_count or None, state, layers


def validate_stackup_decision(
    record: dict[str, Any], base_dir: Path | None = None
) -> dict[str, Any]:
    """Return a deterministic consistency report for one stackup decision."""

    errors: list[str] = []
    warnings: list[str] = []

    if record.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if record.get("kind") != "easyeda-stackup-decision":
        errors.append("kind must be 'easyeda-stackup-decision'")
    revision = record.get("revision")
    if not _nonempty(revision):
        errors.append("revision must be a non-empty exact PCB revision or fingerprint")
    decision_state = _enum(errors, "status", record.get("status"), DECISION_STATES)
    recommended = record.get("recommendedLayerCount")
    if decision_state == "SELECTABLE":
        if not isinstance(recommended, int) or isinstance(recommended, bool) or recommended <= 0:
            errors.append("SELECTABLE requires a positive integer recommendedLayerCount")
    elif recommended is not None and (
        not isinstance(recommended, int) or isinstance(recommended, bool) or recommended <= 0
    ):
        errors.append("recommendedLayerCount must be null or a positive integer")

    _validate_partitions(record, errors)
    decisive_constraints = _string_list(
        errors,
        "decisiveConstraints",
        record.get("decisiveConstraints"),
        nonempty=decision_state in {"SELECTABLE", "CONDITIONAL", "INFEASIBLE"},
    )
    if decision_state in {"SELECTABLE", "CONDITIONAL"} and not _nonempty(
        record.get("reserveBasis")
    ):
        errors.append("reserveBasis must be non-empty for SELECTABLE or CONDITIONAL")
    _string_list(errors, "invalidatedBy", record.get("invalidatedBy"), nonempty=True)

    gates = _string_list(
        errors, "applicableGates", record.get("applicableGates"), nonempty=True
    )
    applicable_gates = set(gates)
    unsupported = sorted(applicable_gates - GATE_CODES)
    if unsupported:
        errors.append(f"applicableGates contains unsupported gates {unsupported}")

    candidates = record.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        errors.append("candidates must be a non-empty array")
        candidates = []
    if decision_state in {"SELECTABLE", "CONDITIONAL"} and len(candidates) < 2:
        errors.append(f"{decision_state} requires at least two compared candidates")

    candidate_rows: list[tuple[int, str, list[dict[str, Any]]]] = []
    seen_counts: set[int] = set()
    floorplan_owners: dict[str, int] = {}
    canary_owners: dict[str, int] = {}
    for index, candidate in enumerate(candidates):
        count, state, layers = _validate_candidate(
            candidate, index, applicable_gates, errors, base_dir
        )
        if count is not None:
            if count in seen_counts:
                errors.append(f"candidates[{index}].layerCount duplicates {count}")
            seen_counts.add(count)
        if count is not None and state is not None:
            candidate_rows.append((count, state, layers))
        if isinstance(candidate, dict):
            floorplan = candidate.get("floorplanArtifact")
            if _nonempty(floorplan):
                floorplan_name = str(floorplan)
                if floorplan_name in floorplan_owners:
                    errors.append(
                        f"candidates[{index}].floorplanArtifact is reused by "
                        f"candidates[{floorplan_owners[floorplan_name]}]"
                    )
                else:
                    floorplan_owners[floorplan_name] = index
            canary_artifacts = candidate.get("canaryArtifacts")
            if isinstance(canary_artifacts, list):
                for artifact_index, canary in enumerate(canary_artifacts):
                    if not _nonempty(canary):
                        continue
                    canary_name = str(canary)
                    if canary_name in canary_owners:
                        errors.append(
                            f"candidates[{index}].canaryArtifacts[{artifact_index}] is "
                            f"reused by candidates[{canary_owners[canary_name]}]"
                        )
                    else:
                        canary_owners[canary_name] = index

    counts = [row[0] for row in candidate_rows]
    if counts != sorted(counts):
        errors.append("candidates must be ordered by increasing layerCount")

    selected_layers: list[dict[str, Any]] | None = None
    if decision_state == "SELECTABLE" and isinstance(recommended, int):
        selected = [row for row in candidate_rows if row[0] == recommended]
        if len(selected) != 1:
            errors.append("recommendedLayerCount must identify exactly one candidate")
        elif selected[0][1] != "SELECTABLE":
            errors.append("recommended candidate must have state SELECTABLE")
        else:
            selected_layers = selected[0][2]
        lower = [row for row in candidate_rows if row[0] < recommended]
        if any(row[1] != "INFEASIBLE" for row in lower):
            errors.append(
                "every lower candidate must be INFEASIBLE before selecting a higher candidate"
            )
        selectable_counts = [row[0] for row in candidate_rows if row[1] == "SELECTABLE"]
        if selectable_counts and recommended != min(selectable_counts):
            errors.append("recommendedLayerCount must be the lowest SELECTABLE candidate")
        higher = sorted(
            (row for row in candidate_rows if row[0] > recommended),
            key=lambda row: row[0],
        )
        if not higher:
            errors.append("SELECTABLE decision requires a next-higher comparison candidate")
        elif higher[0][1] not in {"SELECTABLE", "CONDITIONAL", "UNRESOLVED"}:
            errors.append(
                "the immediate next-higher comparison candidate must be "
                "SELECTABLE, CONDITIONAL, or UNRESOLVED"
            )
    elif decision_state == "CONDITIONAL" and not any(
        row[1] == "CONDITIONAL" for row in candidate_rows
    ):
        errors.append("CONDITIONAL decision requires a CONDITIONAL candidate")
    elif decision_state == "INFEASIBLE" and any(
        row[1] == "SELECTABLE" for row in candidate_rows
    ):
        errors.append("INFEASIBLE decision cannot contain a SELECTABLE candidate")
    elif decision_state == "STALE" and not any(
        row[1] == "STALE" for row in candidate_rows
    ):
        errors.append("STALE decision requires a STALE candidate")

    if decision_state == "SELECTABLE" and not decisive_constraints:
        errors.append("SELECTABLE decision must name decisiveConstraints")

    if errors:
        planning_state = "BLOCKED"
    elif decision_state == "SELECTABLE":
        planning_state = "SELECTABLE"
    else:
        planning_state = decision_state

    return {
        "schemaVersion": 1,
        "kind": "easyeda-stackup-decision-validation",
        "revision": revision,
        "consistent": not errors,
        "decisionStatus": decision_state,
        "planningStatus": planning_state,
        "recommendedLayerCount": recommended,
        "lowestCandidateLayerCount": min(counts) if counts else None,
        "nextHigherCandidateLayerCount": (
            min((count for count in counts if isinstance(recommended, int) and count > recommended), default=None)
        ),
        "selectedLayerTableFingerprint": (
            _fingerprint(selected_layers) if selected_layers is not None else None
        ),
        "fabricationRelease": False,
        "errors": errors,
        "warnings": warnings,
    }


def _exit_code(report: dict[str, Any]) -> int:
    if report["errors"] or report["decisionStatus"] == "INFEASIBLE":
        return 2
    if report["decisionStatus"] in {"CONDITIONAL", "UNRESOLVED"}:
        return 3
    if report["decisionStatus"] == "STALE":
        return 4
    return 0


def _reference(layer: str, tag: str, *, power: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "layer": layer,
        "region": "GND" if not power else "VDD",
        "continuityEvidence": f"evidence/{tag}-continuity.json",
    }
    if power:
        result["highFrequencyReturnEvidence"] = f"evidence/{tag}-hf-return.json"
    return result


def _layers_2(tag: str) -> list[dict[str, Any]]:
    return [
        {
            "name": "Top Layer",
            "role": "primary-signal",
            "references": [_reference("Bottom Layer", f"{tag}-top")],
        },
        {"name": "Bottom Layer", "role": "continuous-reference"},
    ]


def _layers_4(tag: str) -> list[dict[str, Any]]:
    return [
        {
            "name": "Top Layer",
            "role": "primary-signal",
            "references": [_reference("Inner Layer 1", f"{tag}-top")],
        },
        {"name": "Inner Layer 1", "role": "continuous-reference"},
        {"name": "Inner Layer 2", "role": "power-distribution"},
        {
            "name": "Bottom Layer",
            "role": "limited-signal",
            "references": [_reference("Inner Layer 2", f"{tag}-bottom", power=True)],
            "netAllowList": ["GPIO1", "GPIO2"],
        },
    ]


def _layers_even(count: int, tag: str) -> list[dict[str, Any]]:
    if count == 6:
        return [
            {
                "name": "L1 Top",
                "role": "primary-signal",
                "references": [_reference("L2 GND", f"{tag}-l1")],
            },
            {"name": "L2 GND", "role": "continuous-reference"},
            {
                "name": "L3 Signal",
                "role": "primary-signal",
                "references": [_reference("L2 GND", f"{tag}-l3")],
            },
            {"name": "L4 Power", "role": "power-distribution"},
            {"name": "L5 GND", "role": "continuous-reference"},
            {
                "name": "L6 Bottom",
                "role": "limited-signal",
                "references": [_reference("L5 GND", f"{tag}-l6")],
                "maxRoutedLengthSharePct": 20,
            },
        ]
    if count == 8:
        return [
            {
                "name": "L1 Top",
                "role": "primary-signal",
                "references": [_reference("L2 GND", f"{tag}-l1")],
            },
            {"name": "L2 GND", "role": "continuous-reference"},
            {
                "name": "L3 Signal",
                "role": "primary-signal",
                "references": [_reference("L2 GND", f"{tag}-l3")],
            },
            {"name": "L4 Power A", "role": "power-distribution"},
            {"name": "L5 Power B", "role": "power-distribution"},
            {
                "name": "L6 Signal",
                "role": "primary-signal",
                "references": [_reference("L7 GND", f"{tag}-l6")],
            },
            {"name": "L7 GND", "role": "continuous-reference"},
            {
                "name": "L8 Bottom",
                "role": "limited-signal",
                "references": [_reference("L7 GND", f"{tag}-l8")],
                "netAllowList": ["DEBUG_TX", "DEBUG_RX"],
            },
        ]
    if count == 10:
        return [
            {
                "name": "L1 Top",
                "role": "primary-signal",
                "references": [_reference("L2 GND", f"{tag}-l1")],
            },
            {"name": "L2 GND", "role": "continuous-reference"},
            {
                "name": "L3 Signal",
                "role": "primary-signal",
                "references": [_reference("L2 GND", f"{tag}-l3")],
            },
            {"name": "L4 Power A", "role": "power-distribution"},
            {"name": "L5 GND", "role": "continuous-reference"},
            {"name": "L6 GND", "role": "continuous-reference"},
            {"name": "L7 Power B", "role": "power-distribution"},
            {
                "name": "L8 Signal",
                "role": "primary-signal",
                "references": [_reference("L9 GND", f"{tag}-l8")],
            },
            {"name": "L9 GND", "role": "continuous-reference"},
            {
                "name": "L10 Bottom",
                "role": "limited-signal",
                "references": [_reference("L9 GND", f"{tag}-l10")],
                "maxRoutedLengthSharePct": 15,
            },
        ]
    raise ValueError(f"unsupported self-test layer count {count}")


def _gate_results(gates: list[str], tag: str, failed: str | None = None) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for gate in gates:
        if gate == failed:
            results.append(
                {
                    "gate": gate,
                    "status": "FAILED",
                    "reason": f"{gate} canary failed for {tag}",
                    "evidence": f"evidence/{tag}-{gate.lower()}-failed.json",
                    "minimalRemedy": "evaluate the next supported layer construction",
                }
            )
        else:
            results.append(
                {
                    "gate": gate,
                    "status": "CLOSED",
                    "reason": f"{gate} is supported for {tag}",
                    "evidence": f"evidence/{tag}-{gate.lower()}-closed.json",
                }
            )
    return results


def _candidate(
    count: int,
    state: str,
    layers: list[dict[str, Any]],
    gates: list[str],
    tag: str,
    *,
    failed: str | None = None,
    added: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "layerCount": count,
        "state": state,
        "constructionSource": f"fabricator construction {count}L rev A",
        "layerFunctions": layers,
        "addedLayersSolve": added or [],
        "gateResults": _gate_results(gates, tag, failed),
        "openAssumptions": [],
        "requiredCanaries": [],
        "floorplanArtifact": f"evidence/{tag}-floorplan.json",
        "canaryArtifacts": [f"evidence/{tag}-route-canaries.json"],
        "processCostImpact": f"documented {count}L prototype and volume delta",
    }


def _partitions() -> dict[str, Any]:
    return {
        "routingEscape": {
            "minimumDedicatedLayers": 2,
            "basis": ["corridor and escape study"],
            "sharedRoleConditions": ["limited low-speed routing only"],
        },
        "referenceReturn": {
            "minimumDedicatedLayers": 1,
            "basis": ["continuous return requirement"],
            "sharedRoleConditions": [],
        },
        "powerIsolationThermalShielding": {
            "minimumDedicatedLayers": 1,
            "basis": ["rail area and current study"],
            "sharedRoleConditions": ["only outside constrained return regions"],
        },
        "manufacturingMechanical": {
            "minimumDedicatedLayers": 0,
            "basis": ["balanced fabricator-supported even-layer construction"],
            "sharedRoleConditions": [],
        },
    }


def _baseline_record() -> dict[str, Any]:
    gates = [
        "ROUTING_CAPACITY",
        "REFERENCE_CONTINUITY",
        "POWER_PLANE_AREA",
        "MANUFACTURING",
    ]
    return {
        "schemaVersion": 1,
        "kind": "easyeda-stackup-decision",
        "revision": "baseline-4l-revision",
        "status": "SELECTABLE",
        "recommendedLayerCount": 4,
        "demandPartitions": _partitions(),
        "decisiveConstraints": ["continuous reference plus two routing surfaces"],
        "reserveBasis": "one debug pair and one narrow ECO corridor",
        "invalidatedBy": ["outline", "package", "fabricator construction"],
        "applicableGates": gates,
        "candidates": [
            _candidate(
                2,
                "INFEASIBLE",
                _layers_2("base2"),
                gates,
                "base2",
                failed="ROUTING_CAPACITY",
            ),
            _candidate(
                4,
                "SELECTABLE",
                _layers_4("base4"),
                gates,
                "base4",
                added=["REFERENCE_CONTINUITY", "POWER_PLANE_AREA"],
            ),
            _candidate(
                6,
                "SELECTABLE",
                _layers_even(6, "base6"),
                gates,
                "base6",
                added=["ROUTING_CAPACITY", "DESIGN_MARGIN"],
            ),
        ],
    }


def _bga_hdi_record() -> dict[str, Any]:
    gates = [
        "ROUTING_CAPACITY",
        "PACKAGE_ESCAPE",
        "REFERENCE_CONTINUITY",
        "VIA_PROCESS",
        "IMPEDANCE_GEOMETRY",
        "MANUFACTURING",
    ]
    record = {
        "schemaVersion": 1,
        "kind": "easyeda-stackup-decision",
        "revision": "bga-hdi-8l-revision",
        "status": "SELECTABLE",
        "recommendedLayerCount": 8,
        "demandPartitions": _partitions(),
        "decisiveConstraints": ["0.5 mm BGA escape with independently referenced lanes"],
        "reserveBasis": "one spare escape channel per populated quadrant",
        "invalidatedBy": ["ball map", "via process", "placement", "stackup"],
        "applicableGates": gates,
        "candidates": [
            _candidate(
                6,
                "INFEASIBLE",
                _layers_even(6, "hdi6"),
                gates,
                "hdi6",
                failed="PACKAGE_ESCAPE",
            ),
            _candidate(
                8,
                "SELECTABLE",
                _layers_even(8, "hdi8"),
                gates,
                "hdi8",
                added=["PACKAGE_ESCAPE", "REFERENCE_CONTINUITY", "VIA_PROCESS"],
            ),
            _candidate(
                10,
                "SELECTABLE",
                _layers_even(10, "hdi10"),
                gates,
                "hdi10",
                added=["DESIGN_MARGIN", "POWER_PLANE_AREA"],
            ),
        ],
    }
    record["demandPartitions"]["routingEscape"]["minimumDedicatedLayers"] = 4
    record["demandPartitions"]["manufacturingMechanical"]["basis"] = [
        "quoted sequential-lamination and microvia construction"
    ]
    return record


def _self_test() -> int:
    positive = {
        "baseline-4-layer": _baseline_record(),
        "bga-hdi-8-layer": _bga_hdi_record(),
    }
    for name, record in positive.items():
        report = validate_stackup_decision(record, base_dir=None)
        if not report["consistent"] or _exit_code(report) != 0:
            print(f"self-test {name} failed", file=sys.stderr)
            print(json.dumps(report, indent=2, ensure_ascii=False), file=sys.stderr)
            return 1

    negative: list[tuple[str, dict[str, Any]]] = []
    missing_decisive = _baseline_record()
    missing_decisive["decisiveConstraints"] = []
    negative.append(("missing-decisive-constraint", missing_decisive))

    bad_reference = _baseline_record()
    bad_reference["candidates"][1]["layerFunctions"][0]["references"][0]["layer"] = "NOPE"
    negative.append(("missing-reference-layer", bad_reference))

    duplicate_reference = _baseline_record()
    first_reference = duplicate_reference["candidates"][1]["layerFunctions"][0][
        "references"
    ][0]
    duplicate_reference["candidates"][1]["layerFunctions"][0]["references"].append(
        copy.deepcopy(first_reference)
    )
    negative.append(("duplicate-reference-target", duplicate_reference))

    unlimited_layer = _baseline_record()
    limited = unlimited_layer["candidates"][1]["layerFunctions"][3]
    del limited["netAllowList"]
    negative.append(("unbounded-limited-layer", unlimited_layer))

    missing_hf_return = _baseline_record()
    reference = missing_hf_return["candidates"][1]["layerFunctions"][3]["references"][0]
    del reference["highFrequencyReturnEvidence"]
    negative.append(("power-reference-missing-hf-return", missing_hf_return))

    unresolved_lower = _baseline_record()
    unresolved_lower["candidates"][0]["state"] = "UNRESOLVED"
    unresolved_lower["candidates"][0]["gateResults"][0] = {
        "gate": "ROUTING_CAPACITY",
        "status": "OPEN",
        "reason": "corridor proof is missing",
        "missingEvidence": "representative route canary",
    }
    unresolved_lower["candidates"][0]["requiredCanaries"] = ["route canary"]
    negative.append(("unresolved-lower-candidate", unresolved_lower))

    no_upper = _baseline_record()
    no_upper["candidates"] = no_upper["candidates"][:2]
    negative.append(("missing-next-higher", no_upper))

    infeasible_upper = _baseline_record()
    infeasible_upper["candidates"][2]["state"] = "INFEASIBLE"
    infeasible_upper["candidates"][2]["gateResults"][0] = {
        "gate": "ROUTING_CAPACITY",
        "status": "FAILED",
        "reason": "candidate-specific route canary failed",
        "evidence": "evidence/base6-routing_capacity-failed.json",
        "minimalRemedy": "evaluate the next supported construction",
    }
    negative.append(("infeasible-next-higher", infeasible_upper))

    shared_candidate_evidence = _baseline_record()
    shared_candidate_evidence["candidates"][1]["floorplanArtifact"] = (
        shared_candidate_evidence["candidates"][0]["floorplanArtifact"]
    )
    shared_candidate_evidence["candidates"][1]["canaryArtifacts"] = copy.deepcopy(
        shared_candidate_evidence["candidates"][0]["canaryArtifacts"]
    )
    negative.append(("shared-evidence-across-candidates", shared_candidate_evidence))

    missing_added_purpose = _baseline_record()
    missing_added_purpose["candidates"][1]["addedLayersSolve"] = []
    negative.append(("missing-added-layer-purpose", missing_added_purpose))

    unsupported_added_purpose = _baseline_record()
    unsupported_added_purpose["candidates"][1]["addedLayersSolve"] = ["MORE_LAYERS"]
    negative.append(("unsupported-added-layer-purpose", unsupported_added_purpose))

    adjacent_signal = _baseline_record()
    adjacent_signal["candidates"][2]["layerFunctions"][1]["role"] = "limited-signal"
    adjacent_signal["candidates"][2]["layerFunctions"][1]["references"] = [
        _reference("L3 Signal", "adjacent-l2")
    ]
    adjacent_signal["candidates"][2]["layerFunctions"][1]["netAllowList"] = ["TEST"]
    negative.append(("adjacent-signal-no-coupling-evidence", adjacent_signal))

    for name, record in negative:
        report = validate_stackup_decision(record, base_dir=None)
        if report["consistent"] or not report["errors"]:
            print(f"self-test {name} unexpectedly passed", file=sys.stderr)
            print(json.dumps(report, indent=2, ensure_ascii=False), file=sys.stderr)
            return 1

    missing_artifacts = validate_stackup_decision(
        _baseline_record(), base_dir=Path("/__easyeda_stackup_missing_artifacts__")
    )
    if missing_artifacts["consistent"]:
        print("self-test missing-artifacts unexpectedly passed", file=sys.stderr)
        return 1

    print(
        "easyeda_stackup_decision_lint self-test passed "
        f"({len(positive)} positive, {len(negative) + 1} negative cases)"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a PCB layer-count candidate comparison"
    )
    parser.add_argument("--record", type=Path, help="path to stackup-candidates.json")
    parser.add_argument("--output", type=Path, help="optional write-once JSON report path")
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
        print(f"failed to read stackup decision: {exc}", file=sys.stderr)
        return 2
    if not isinstance(record, dict):
        print("stackup decision root must be an object", file=sys.stderr)
        return 2

    report = validate_stackup_decision(record, base_dir=args.record.resolve().parent)
    report["decisionRecordFingerprint"] = (
        "sha256:" + hashlib.sha256(record_bytes).hexdigest()
    )
    rendered = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        if args.output.resolve() == args.record.resolve():
            print("refusing to overwrite the input stackup decision", file=sys.stderr)
            return 2
        try:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as handle:
                handle.write(rendered)
        except FileExistsError:
            print(f"refusing to overwrite existing evidence: {args.output}", file=sys.stderr)
            return 2
        except OSError as exc:
            print(f"failed to write stackup consistency evidence: {exc}", file=sys.stderr)
            return 2
    else:
        sys.stdout.write(rendered)
    return _exit_code(report)


if __name__ == "__main__":
    raise SystemExit(main())
