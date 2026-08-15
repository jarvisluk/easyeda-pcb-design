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
import importlib.util
import json
import math
import sys
import tempfile
from pathlib import Path
from typing import Any


PLACEMENT_STATES = {"FEASIBLE", "INFEASIBLE", "UNRESOLVED", "STALE"}
DISPOSITIONS = {"FOLLOW", "PROPOSE_REVISION", "UNRESOLVED", "STALE"}
LAYER_STATES = {"SELECTABLE", "CONDITIONAL", "INFEASIBLE", "UNRESOLVED", "STALE"}
ENTRY_STATES = {"CLEARED_FOR_PLACEMENT", "BLOCKED", "UNRESOLVED", "STALE"}
CONSTRAINT_BASES = {"AUTHORED_BEFORE_PLACEMENT", "RECONSTRUCTED"}
SPECIALIZED_STATES = ENTRY_STATES | {"NOT_APPLICABLE"}
CONFLICT_STATES = {"RESOLVED", "BLOCKED", "UNRESOLVED", "STALE"}
HUMAN_INTERFACE_DECISIONS = {"GROUP_TOGETHER", "SEPARATE_WITH_RATIONALE"}
BOARD_GENDERS = {"MALE", "FEMALE", "CONTACT_PAD", "INTEGRATED", "OTHER"}
SPECIAL_VIA_CONSTRUCTIONS = {
    "FILLED_CAPPED_PLANARIZED",
    "MICROVIA_FILLED_CAPPED",
    "DOCUMENTED_LAND_PATTERN_PROCESS",
}
STACKUP_GATE_CODES = {
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
BOARD_BOUNDARY_BINDINGS = {"PLANNING_CANDIDATE", "LIVE_NATIVE"}
BOARD_EDGE_SUBJECT_TYPES = {"ASSEMBLY_ENVELOPE", "CRITICAL_ZONE"}
BOARD_EDGE_RELATIONS = {"ALLOWED_OVERHANG", "EDGE_ALIGNED"}


def _nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _optional_finite_geometry_fields(
    errors: list[str], prefix: str, geometry: dict[str, Any]
) -> None:
    for field in ("centerXMil", "centerYMil", "rotationDeg"):
        if field not in geometry:
            continue
        value = geometry[field]
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
        ):
            errors.append(f"{prefix}.{field} must be a finite number when present")


def _is_simple_nonzero_polygon(points: Any) -> bool:
    epsilon = 1e-9
    if not isinstance(points, list) or len(points) < 3:
        return False
    if any(
        not isinstance(point, list)
        or len(point) != 2
        or any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
            for value in point
        )
        for point in points
    ):
        return False

    def orientation(first: list[float], second: list[float], third: list[float]) -> int:
        value = (second[1] - first[1]) * (third[0] - second[0]) - (
            second[0] - first[0]
        ) * (third[1] - second[1])
        if abs(value) <= epsilon:
            return 0
        return 1 if value > 0 else 2

    def on_segment(first: list[float], point: list[float], second: list[float]) -> bool:
        return (
            point[0] <= max(first[0], second[0]) + epsilon
            and point[0] + epsilon >= min(first[0], second[0])
            and point[1] <= max(first[1], second[1]) + epsilon
            and point[1] + epsilon >= min(first[1], second[1])
        )

    def intersects(
        first_start: list[float],
        first_end: list[float],
        second_start: list[float],
        second_end: list[float],
    ) -> bool:
        first_orientation = orientation(first_start, first_end, second_start)
        second_orientation = orientation(first_start, first_end, second_end)
        third_orientation = orientation(second_start, second_end, first_start)
        fourth_orientation = orientation(second_start, second_end, first_end)
        if first_orientation != second_orientation and third_orientation != fourth_orientation:
            return True
        return (
            (first_orientation == 0 and on_segment(first_start, second_start, first_end))
            or (second_orientation == 0 and on_segment(first_start, second_end, first_end))
            or (third_orientation == 0 and on_segment(second_start, first_start, second_end))
            or (fourth_orientation == 0 and on_segment(second_start, first_end, second_end))
        )

    twice_area = 0.0
    for index, start in enumerate(points):
        end = points[(index + 1) % len(points)]
        if (end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2 <= epsilon**2:
            return False
        twice_area += start[0] * end[1] - end[0] * start[1]
    if abs(twice_area) <= epsilon:
        return False

    for first in range(len(points)):
        first_next = (first + 1) % len(points)
        for second in range(first + 1, len(points)):
            second_next = (second + 1) % len(points)
            if first_next == second or second_next == first:
                continue
            if intersects(
                points[first], points[first_next], points[second], points[second_next]
            ):
                return False
    return True


def _artifact_exists(value: Any, base_dir: Path | None) -> bool:
    if not _nonempty(value):
        return False
    if base_dir is None:
        return True
    artifact = Path(value)
    if not artifact.is_absolute():
        artifact = base_dir / artifact
    return artifact.is_file()


def _resolve_artifact(value: Any, base_dir: Path | None) -> Path | None:
    if not _nonempty(value) or base_dir is None:
        return None
    artifact = Path(value)
    if not artifact.is_absolute():
        artifact = base_dir / artifact
    return artifact


def _fingerprint(value: Any) -> str:
    rendered = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(rendered).hexdigest()


def _load_json_artifact(
    errors: list[str], field: str, value: Any, base_dir: Path | None
) -> tuple[Path | None, dict[str, Any] | None]:
    artifact = _resolve_artifact(value, base_dir)
    if artifact is None:
        return None, None
    try:
        loaded = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"{field} could not be read as JSON: {exc}")
        return artifact, None
    if not isinstance(loaded, dict):
        errors.append(f"{field} root must be an object")
        return artifact, None
    return artifact, loaded


_STACKUP_MODULE: Any | None = None


def _load_stackup_module() -> Any:
    """Load the sibling stackup validator without relying on caller sys.path."""

    global _STACKUP_MODULE
    if _STACKUP_MODULE is not None:
        return _STACKUP_MODULE
    script = Path(__file__).with_name("easyeda_stackup_decision_lint.py")
    spec = importlib.util.spec_from_file_location("easyeda_stackup_decision_lint", script)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load stackup validator from {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _STACKUP_MODULE = module
    return module


def _enum(
    errors: list[str], field: str, value: Any, allowed: set[str]
) -> str | None:
    if value not in allowed:
        errors.append(f"{field} must be one of {sorted(allowed)}; got {value!r}")
        return None
    return str(value)


def _positive(errors: list[str], field: str, value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        errors.append(f"{field} must be a positive number")
        return None
    return float(value)


def _string_list(
    errors: list[str], field: str, value: Any, *, nonempty: bool = False
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
            result.append(item.strip())
    if len(result) != len(set(result)):
        errors.append(f"{field} must not contain duplicates")
    return result


def _validate_demand_partitions(
    errors: list[str], value: Any, prefix: str
) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{prefix} must be an object")
        return {}
    missing = sorted(DEMAND_PARTITIONS - set(value))
    extra = sorted(set(value) - DEMAND_PARTITIONS)
    if missing:
        errors.append(f"{prefix} is missing {missing}")
    if extra:
        errors.append(f"{prefix} has unsupported keys {extra}")
    for name in sorted(DEMAND_PARTITIONS & set(value)):
        partition = value[name]
        partition_prefix = f"{prefix}.{name}"
        if not isinstance(partition, dict):
            errors.append(f"{partition_prefix} must be an object")
            continue
        count = partition.get("minimumDedicatedLayers")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            errors.append(
                f"{partition_prefix}.minimumDedicatedLayers must be an integer >= 0"
            )
        _string_list(
            errors, f"{partition_prefix}.basis", partition.get("basis"), nonempty=True
        )
        _string_list(
            errors,
            f"{partition_prefix}.sharedRoleConditions",
            partition.get("sharedRoleConditions"),
            nonempty=False,
        )
    return value


def _validate_layer_table(
    errors: list[str], layers: Any, count: Any, base_dir: Path | None
) -> list[dict[str, Any]]:
    if not isinstance(layers, list) or not layers:
        errors.append("SELECTABLE layerCountDecision requires a non-empty layers table")
        return []
    if isinstance(count, int) and not isinstance(count, bool) and len(layers) != count:
        errors.append("layers table length must equal layerCountDecision.recommendedLayerCount")

    names: dict[str, int] = {}
    for index, item in enumerate(layers):
        prefix = f"layers[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        name = item.get("name")
        if not _nonempty(name):
            errors.append(f"{prefix}.name must be a non-empty string")
        elif name in names:
            errors.append(f"{prefix}.name duplicates {name!r}")
        else:
            names[str(name)] = index
        _enum(errors, f"{prefix}.role", item.get("role"), LAYER_ROLES)

    for index, item in enumerate(layers):
        if not isinstance(item, dict):
            continue
        prefix = f"layers[{index}]"
        role = item.get("role")
        references = item.get("references")
        if role in SIGNAL_ROLES:
            if not isinstance(references, list) or not 1 <= len(references) <= 2:
                errors.append(f"{prefix}.references must contain one or two references")
                references = []
            reference_targets: set[str] = set()
            for ref_index, reference in enumerate(references):
                ref_prefix = f"{prefix}.references[{ref_index}]"
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
                target_item = layers[target_index]
                target_role = target_item.get("role") if isinstance(target_item, dict) else None
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
                allow_list = item.get("netAllowList")
                valid_allow_list = isinstance(allow_list, list) and bool(allow_list)
                if valid_allow_list:
                    _string_list(errors, f"{prefix}.netAllowList", allow_list, nonempty=True)
                share = item.get("maxRoutedLengthSharePct")
                valid_share = (
                    isinstance(share, (int, float))
                    and not isinstance(share, bool)
                    and 0 < float(share) <= 100
                )
                if not valid_allow_list and not valid_share:
                    errors.append(
                        f"{prefix} limited-signal requires netAllowList or "
                        "maxRoutedLengthSharePct in (0, 100]"
                    )
        elif references is not None:
            errors.append(f"{prefix}.references is allowed only on signal layers")

        if role in {"continuous-reference", "forbidden"}:
            if item.get("netAllowList") not in (None, []):
                errors.append(f"{prefix}.netAllowList contradicts role {role}")
            if item.get("maxRoutedLengthSharePct") is not None:
                errors.append(f"{prefix}.maxRoutedLengthSharePct contradicts role {role}")
    return layers


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

    _enum(errors, "constraintBasis", record.get("constraintBasis"), CONSTRAINT_BASES)

    revision = record.get("revision")
    if not _nonempty(revision):
        errors.append("revision must be a non-empty exact PCB revision or fingerprint")
    elif str(revision).startswith("planning:"):
        if not str(revision).startswith("planning:sha256:") or len(str(revision)) != 80:
            errors.append(
                "planning revision must be planning:sha256:<64 lowercase hex characters>"
            )
        else:
            digest = str(revision).removeprefix("planning:sha256:")
            if any(character not in "0123456789abcdef" for character in digest):
                errors.append(
                    "planning revision digest must contain lowercase hexadecimal characters"
                )
        planning = record.get("planningRevision")
        if not isinstance(planning, dict):
            errors.append("planningRevision must be an object for a planning revision")
            planning = {}
        for field in ("projectUuid", "schematicPageUuid", "outlineCandidateId"):
            if not _nonempty(planning.get(field)):
                errors.append(f"planningRevision.{field} must be a non-empty string")
        for field in (
            "schematicFingerprint",
            "footprintSetFingerprint",
            "interfaceDecisionFingerprint",
            "processProfileFingerprint",
        ):
            value = planning.get(field)
            if (
                not _nonempty(value)
                or not str(value).startswith("sha256:")
                or len(str(value)) != 71
                or any(
                    character not in "0123456789abcdef"
                    for character in str(value)[7:]
                )
            ):
                errors.append(
                    f"planningRevision.{field} must be sha256:<64 lowercase hex characters>"
                )
    elif record.get("planningRevision") not in (None, {}):
        errors.append(
            "planningRevision is allowed only when revision uses planning:sha256:<hex>"
        )

    board_boundary = record.get("boardBoundary")
    if not isinstance(board_boundary, dict):
        errors.append("boardBoundary must be an object")
        board_boundary = {}
    boundary_binding = _enum(
        errors,
        "boardBoundary.binding",
        board_boundary.get("binding"),
        BOARD_BOUNDARY_BINDINGS,
    )
    if not _nonempty(board_boundary.get("source")):
        errors.append("boardBoundary.source must identify the mechanical authority")
    if boundary_binding == "PLANNING_CANDIDATE":
        if not str(revision or "").startswith("planning:sha256:"):
            errors.append("PLANNING_CANDIDATE boardBoundary requires a planning revision")
        if not _nonempty(board_boundary.get("outlineCandidateId")):
            errors.append("boardBoundary.outlineCandidateId is required for planning")
        if not _artifact_exists(board_boundary.get("geometryArtifact"), base_dir):
            errors.append("planning boardBoundary requires an existing geometryArtifact")
    elif boundary_binding == "LIVE_NATIVE":
        layer_id = board_boundary.get("outlineLayerId")
        if isinstance(layer_id, bool) or not isinstance(layer_id, (int, float)) or not math.isfinite(float(layer_id)):
            errors.append("boardBoundary.outlineLayerId must be a finite live layer id")
        if not _nonempty(board_boundary.get("outerContourPrimitiveId")):
            errors.append("boardBoundary.outerContourPrimitiveId is required for live binding")
        cutouts = board_boundary.get("cutoutPrimitiveIds")
        if not isinstance(cutouts, list) or any(not _nonempty(item) for item in cutouts):
            errors.append("boardBoundary.cutoutPrimitiveIds must be an array of primitive ids")
        elif len(cutouts) != len(set(cutouts)):
            errors.append("boardBoundary.cutoutPrimitiveIds must be unique")
        if board_boundary.get("requireLocked") is not True:
            errors.append("a cleared live boardBoundary must set requireLocked true")
    edge_relations = board_boundary.get("edgeRelations")
    if not isinstance(edge_relations, list):
        errors.append("boardBoundary.edgeRelations must be an array")
        edge_relations = []
    seen_edge_subjects: set[tuple[str, str]] = set()
    for index, relation in enumerate(edge_relations):
        prefix = f"boardBoundary.edgeRelations[{index}]"
        if not isinstance(relation, dict):
            errors.append(f"{prefix} must be an object")
            continue
        subject_type = _enum(
            errors, f"{prefix}.subjectType", relation.get("subjectType"), BOARD_EDGE_SUBJECT_TYPES
        )
        subject_id = relation.get("subjectId")
        if not _nonempty(subject_id):
            errors.append(f"{prefix}.subjectId must be a non-empty string")
        elif subject_type:
            key = (subject_type, subject_id)
            if key in seen_edge_subjects:
                errors.append(f"{prefix} duplicates an earlier edge-relation subject")
            seen_edge_subjects.add(key)
        _enum(errors, f"{prefix}.relation", relation.get("relation"), BOARD_EDGE_RELATIONS)
        if not _nonempty(relation.get("source")):
            errors.append(f"{prefix}.source is required")
        if not _artifact_exists(relation.get("evidenceArtifact"), base_dir):
            errors.append(f"{prefix}.evidenceArtifact must name an existing artifact")

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
        validation_artifact = layer.get("validationArtifact")
        if not _artifact_exists(validation_artifact, base_dir):
            errors.append(
                "SELECTABLE layerCountDecision requires an existing validationArtifact"
            )

        partitions = _validate_demand_partitions(
            errors,
            layer.get("demandPartitions"),
            "layerCountDecision.demandPartitions",
        )

        _string_list(
            errors,
            "layerCountDecision.decisiveConstraints",
            layer.get("decisiveConstraints"),
            nonempty=True,
        )
        if not _nonempty(layer.get("nextHigherComparison")):
            errors.append("layerCountDecision.nextHigherComparison must be non-empty")
        if not _nonempty(layer.get("reserveBasis")):
            errors.append("layerCountDecision.reserveBasis must be non-empty")
        _string_list(
            errors,
            "layerCountDecision.assumptions",
            layer.get("assumptions"),
            nonempty=False,
        )
        required_canaries = _string_list(
            errors,
            "layerCountDecision.requiredCanaries",
            layer.get("requiredCanaries"),
            nonempty=False,
        )
        if required_canaries:
            errors.append("SELECTABLE layerCountDecision cannot retain requiredCanaries")
        _string_list(
            errors,
            "layerCountDecision.invalidatedBy",
            layer.get("invalidatedBy"),
            nonempty=True,
        )

        lower_rejections = layer.get("lowerCandidateRejection")
        if not isinstance(lower_rejections, list):
            errors.append("layerCountDecision.lowerCandidateRejection must be an array")
            lower_rejections = []
        for index, rejection in enumerate(lower_rejections):
            prefix = f"layerCountDecision.lowerCandidateRejection[{index}]"
            if not isinstance(rejection, dict):
                errors.append(f"{prefix} must be an object")
                continue
            _enum(errors, f"{prefix}.gate", rejection.get("gate"), STACKUP_GATE_CODES)
            if not _nonempty(rejection.get("reason")):
                errors.append(f"{prefix}.reason must be non-empty")
            if not _artifact_exists(rejection.get("evidence"), base_dir):
                errors.append(f"{prefix}.evidence must name an artifact")

        layers = _validate_layer_table(errors, record.get("layers"), count, base_dir)

        candidate_path, candidate_record = _load_json_artifact(
            errors,
            "layerCountDecision.candidateComparisonArtifact",
            artifact,
            base_dir,
        )
        validation_path, validation = _load_json_artifact(
            errors,
            "layerCountDecision.validationArtifact",
            validation_artifact,
            base_dir,
        )
        live_validation: dict[str, Any] | None = None
        if candidate_record is not None and candidate_path is not None:
            try:
                live_validation = _load_stackup_module().validate_stackup_decision(
                    candidate_record, base_dir=candidate_path.parent
                )
            except Exception as exc:
                errors.append(f"candidateComparisonArtifact could not be revalidated: {exc}")
            else:
                if live_validation.get("consistent") is not True:
                    detail = "; ".join(live_validation.get("errors", [])[:3])
                    errors.append(
                        "candidateComparisonArtifact fails live semantic validation"
                        + (f": {detail}" if detail else "")
                    )
                if live_validation.get("decisionStatus") != "SELECTABLE":
                    errors.append("live stackup decisionStatus is not SELECTABLE")
                if live_validation.get("revision") != record.get("revision"):
                    errors.append("live stackup revision does not match layout record")
                if live_validation.get("recommendedLayerCount") != count:
                    errors.append("live stackup recommendedLayerCount does not match")
                if live_validation.get("selectedLayerTableFingerprint") != _fingerprint(layers):
                    errors.append("layout layers do not match the live selected layer table")
                if _fingerprint(candidate_record.get("demandPartitions")) != _fingerprint(
                    partitions
                ):
                    errors.append(
                        "layerCountDecision.demandPartitions do not match the candidate record"
                    )
        if validation is not None:
            if validation.get("schemaVersion") != 1:
                errors.append("stackup validation schemaVersion must be 1")
            if validation.get("kind") != "easyeda-stackup-decision-validation":
                errors.append("stackup validation kind is invalid")
            if validation.get("consistent") is not True:
                errors.append("stackup validation is not consistent")
            if validation.get("decisionStatus") != "SELECTABLE":
                errors.append("stackup validation decisionStatus is not SELECTABLE")
            if validation.get("fabricationRelease") is not False:
                errors.append("stackup validation must retain fabricationRelease false")
            if validation.get("revision") != record.get("revision"):
                errors.append("stackup validation revision does not match layout record")
            if validation.get("recommendedLayerCount") != count:
                errors.append("stackup validation recommendedLayerCount does not match")
            lowest_count = validation.get("lowestCandidateLayerCount")
            if isinstance(count, int) and isinstance(lowest_count, int) and count > lowest_count:
                if not lower_rejections:
                    errors.append(
                        "a selected candidate above the lowest evaluated count requires "
                        "lowerCandidateRejection"
                    )
            if validation.get("nextHigherCandidateLayerCount") is None:
                errors.append("stackup validation lacks a next-higher comparison")
            if validation.get("selectedLayerTableFingerprint") != _fingerprint(layers):
                errors.append("layout layers do not match the validated selected layer table")
            if live_validation is not None:
                for field in (
                    "consistent",
                    "decisionStatus",
                    "planningStatus",
                    "recommendedLayerCount",
                    "lowestCandidateLayerCount",
                    "nextHigherCandidateLayerCount",
                    "selectedLayerTableFingerprint",
                    "fabricationRelease",
                ):
                    if validation.get(field) != live_validation.get(field):
                        errors.append(
                            f"stackup validation {field} does not match live revalidation"
                        )
            if candidate_path is not None:
                try:
                    candidate_fingerprint = (
                        "sha256:" + hashlib.sha256(candidate_path.read_bytes()).hexdigest()
                    )
                except OSError as exc:
                    errors.append(f"candidateComparisonArtifact could not be fingerprinted: {exc}")
                else:
                    if validation.get("decisionRecordFingerprint") != candidate_fingerprint:
                        errors.append("stackup validation is stale for candidateComparisonArtifact")
            if (
                validation_path is not None
                and candidate_path is not None
                and validation_path.resolve() == candidate_path.resolve()
            ):
                errors.append("validationArtifact must not overwrite candidateComparisonArtifact")
    elif layer_state == "INFEASIBLE":
        blocked.append("layerCountDecision.status is INFEASIBLE")
    elif layer_state == "STALE":
        stale.append("layerCountDecision.status is STALE")
    elif layer_state in {"CONDITIONAL", "UNRESOLVED"}:
        unresolved.append(f"layerCountDecision.status is {layer_state}")

    routing_geometry = record.get("routingGeometry")
    if not isinstance(routing_geometry, dict):
        errors.append("routingGeometry must be an object")
        routing_geometry = {}
    allowed_angles = routing_geometry.get("allowedAnglesDeg")
    if not isinstance(allowed_angles, list) or not allowed_angles:
        errors.append("routingGeometry.allowedAnglesDeg must be a non-empty array")
    elif any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in allowed_angles):
        errors.append("routingGeometry.allowedAnglesDeg must contain only numbers")
    if not _nonempty(routing_geometry.get("hardRightAngleJunctions")):
        errors.append("routingGeometry.hardRightAngleJunctions must be a non-empty string")
    standard_via = routing_geometry.get("standardVia")
    if not isinstance(standard_via, dict):
        errors.append("routingGeometry.standardVia must be an object")
        standard_via = {}
    _positive(errors, "routingGeometry.standardVia.outerDiameterMm", standard_via.get("outerDiameterMm"))
    _positive(errors, "routingGeometry.standardVia.holeDiameterMm", standard_via.get("holeDiameterMm"))
    _positive(
        errors,
        "routingGeometry.standardVia.viaToPadCopperClearanceMm",
        standard_via.get("viaToPadCopperClearanceMm"),
    )
    if standard_via.get("clearanceMeasurement") != "COPPER_EDGE_TO_COPPER_EDGE":
        errors.append(
            "routingGeometry.standardVia.clearanceMeasurement must be COPPER_EDGE_TO_COPPER_EDGE"
        )
    if not _nonempty(standard_via.get("ruleSource")):
        errors.append("routingGeometry.standardVia.ruleSource must be a non-empty sourced rule")

    assembly = record.get("assembly")
    if not isinstance(assembly, dict):
        errors.append("assembly must be an object")
        assembly = {}
    _positive(errors, "assembly.silkscreenToMaskOrPadMm", assembly.get("silkscreenToMaskOrPadMm"))
    _positive(
        errors,
        "assembly.foreignPadCopperClearanceMm",
        assembly.get("foreignPadCopperClearanceMm"),
    )
    for field in (
        "silkscreenRuleSource",
        "bodyToOwnPadPolicy",
        "componentSpacingSource",
        "courtyardSource",
        "foreignPadCopperClearanceSource",
    ):
        if not _nonempty(assembly.get(field)):
            errors.append(f"assembly.{field} must be a non-empty sourced policy")
    if assembly.get("ownPadCourtyardPolicy") != "ALL_LIVE_PAD_COPPER_WITHIN_SOURCED_COURTYARD":
        errors.append(
            "assembly.ownPadCourtyardPolicy must be "
            "ALL_LIVE_PAD_COPPER_WITHIN_SOURCED_COURTYARD"
        )
    if assembly.get("foreignPadOverlapPolicy") != "CHECK_ALL_FOREIGN_PADS_AND_COURTYARDS":
        errors.append(
            "assembly.foreignPadOverlapPolicy must be "
            "CHECK_ALL_FOREIGN_PADS_AND_COURTYARDS"
        )

    envelopes = record.get("assemblyEnvelopes")
    if not isinstance(envelopes, list) or not envelopes:
        errors.append("assemblyEnvelopes must be a non-empty array")
        envelopes = []
    envelope_refs: set[str] = set()
    for index, envelope in enumerate(envelopes):
        prefix = f"assemblyEnvelopes[{index}]"
        if not isinstance(envelope, dict):
            errors.append(f"{prefix} must be an object")
            continue
        designator = envelope.get("designator")
        if not _nonempty(designator):
            errors.append(f"{prefix}.designator must be a non-empty string")
        elif designator in envelope_refs:
            errors.append(f"{prefix}.designator duplicates {designator!r}")
        else:
            envelope_refs.add(str(designator))
        if not _nonempty(envelope.get("source")):
            errors.append(f"{prefix}.source must identify the body/courtyard authority")
        geometry = envelope.get("courtyard")
        if not isinstance(geometry, dict):
            errors.append(f"{prefix} must contain sourced courtyard geometry")
            continue
        geometry_type = geometry.get("type")
        if geometry_type == "RECT":
            _positive(errors, f"{prefix}.geometry.widthMil", geometry.get("widthMil"))
            _positive(errors, f"{prefix}.geometry.heightMil", geometry.get("heightMil"))
            _optional_finite_geometry_fields(errors, f"{prefix}.geometry", geometry)
        elif geometry_type == "POLYGON":
            for field in ("centerXMil", "centerYMil", "rotationDeg"):
                if field in geometry:
                    errors.append(f"{prefix}.geometry.{field} is invalid for POLYGON")
            points = geometry.get("pointsMil")
            if not isinstance(points, list) or len(points) < 3:
                errors.append(f"{prefix}.geometry.pointsMil must contain at least three points")
            else:
                for point_index, point in enumerate(points):
                    if (
                        not isinstance(point, list)
                        or len(point) != 2
                        or any(
                            isinstance(value, bool)
                            or not isinstance(value, (int, float))
                            for value in point
                        )
                    ):
                        errors.append(
                            f"{prefix}.geometry.pointsMil[{point_index}] must be [x, y] numbers"
                        )
                if not _is_simple_nonzero_polygon(points):
                    errors.append(
                        f"{prefix}.geometry.pointsMil must form a simple non-zero-area polygon"
                    )
        else:
            errors.append(f"{prefix}.geometry.type must be RECT or POLYGON")
        if geometry.get("coordinates", "COMPONENT_LOCAL") not in {"COMPONENT_LOCAL", "BOARD"}:
            errors.append(f"{prefix}.geometry.coordinates must be COMPONENT_LOCAL or BOARD")
        if geometry.get("bottomSideTransform") not in {
            None,
            "MIRROR_LOCAL_X_THEN_ROTATE",
        }:
            errors.append(
                f"{prefix}.geometry.bottomSideTransform must be "
                "MIRROR_LOCAL_X_THEN_ROTATE when present"
            )
        if (
            geometry.get("coordinates", "COMPONENT_LOCAL") == "BOARD"
            and geometry.get("bottomSideTransform") is not None
        ):
            errors.append(
                f"{prefix}.geometry.bottomSideTransform is invalid with BOARD coordinates"
            )
        opposite = envelope.get("oppositeSideCourtyard")
        if opposite is not None:
            if not isinstance(opposite, dict):
                errors.append(f"{prefix}.oppositeSideCourtyard must be an object")
            elif opposite.get("type") == "RECT":
                _positive(
                    errors,
                    f"{prefix}.oppositeSideCourtyard.widthMil",
                    opposite.get("widthMil"),
                )
                _positive(
                    errors,
                    f"{prefix}.oppositeSideCourtyard.heightMil",
                    opposite.get("heightMil"),
                )
                _optional_finite_geometry_fields(
                    errors,
                    f"{prefix}.oppositeSideCourtyard",
                    opposite,
                )
            elif opposite.get("type") == "POLYGON":
                for field in ("centerXMil", "centerYMil", "rotationDeg"):
                    if field in opposite:
                        errors.append(
                            f"{prefix}.oppositeSideCourtyard.{field} is invalid for POLYGON"
                        )
                points = opposite.get("pointsMil")
                if not isinstance(points, list) or len(points) < 3:
                    errors.append(
                        f"{prefix}.oppositeSideCourtyard.pointsMil must contain at least three points"
                    )
                else:
                    for point_index, point in enumerate(points):
                        if (
                            not isinstance(point, list)
                            or len(point) != 2
                            or any(
                                isinstance(value, bool)
                                or not isinstance(value, (int, float))
                                for value in point
                            )
                        ):
                            errors.append(
                                f"{prefix}.oppositeSideCourtyard.pointsMil[{point_index}] "
                                "must be [x, y] numbers"
                            )
                    if not _is_simple_nonzero_polygon(points):
                        errors.append(
                            f"{prefix}.oppositeSideCourtyard.pointsMil must form a "
                            "simple non-zero-area polygon"
                        )
            else:
                errors.append(f"{prefix}.oppositeSideCourtyard.type must be RECT or POLYGON")
            if isinstance(opposite, dict) and opposite.get(
                "coordinates", "COMPONENT_LOCAL"
            ) not in {"COMPONENT_LOCAL", "BOARD"}:
                errors.append(
                    f"{prefix}.oppositeSideCourtyard.coordinates must be COMPONENT_LOCAL or BOARD"
                )
            if isinstance(opposite, dict) and opposite.get("bottomSideTransform") not in {
                None,
                "MIRROR_LOCAL_X_THEN_ROTATE",
            }:
                errors.append(
                    f"{prefix}.oppositeSideCourtyard.bottomSideTransform must be "
                    "MIRROR_LOCAL_X_THEN_ROTATE when present"
                )
            if (
                isinstance(opposite, dict)
                and opposite.get("coordinates", "COMPONENT_LOCAL") == "BOARD"
                and opposite.get("bottomSideTransform") is not None
            ):
                errors.append(
                    f"{prefix}.oppositeSideCourtyard.bottomSideTransform is invalid "
                    "with BOARD coordinates"
                )
        padstack_evidence = envelope.get("padstackProjectionEvidence")
        if padstack_evidence is not None:
            if not isinstance(padstack_evidence, list) or not padstack_evidence:
                errors.append(f"{prefix}.padstackProjectionEvidence must be a non-empty array")
            else:
                pad_numbers: set[str] = set()
                for evidence_index, evidence in enumerate(padstack_evidence):
                    evidence_prefix = f"{prefix}.padstackProjectionEvidence[{evidence_index}]"
                    if not isinstance(evidence, dict):
                        errors.append(f"{evidence_prefix} must be an object")
                        continue
                    pad_number = evidence.get("padNumber")
                    if not _nonempty(pad_number):
                        errors.append(f"{evidence_prefix}.padNumber must be a non-empty string")
                    elif str(pad_number) in pad_numbers:
                        errors.append(f"{evidence_prefix}.padNumber duplicates {pad_number!r}")
                    else:
                        pad_numbers.add(str(pad_number))
                    if evidence.get("policy") != "MAXIMUM_COPPER_PROJECTION":
                        errors.append(
                            f"{evidence_prefix}.policy must be MAXIMUM_COPPER_PROJECTION"
                        )
                    if not _nonempty(evidence.get("source")):
                        errors.append(f"{evidence_prefix}.source must be a non-empty authority")

    zones = record.get("criticalPlacementZones")
    if not isinstance(zones, list):
        errors.append("criticalPlacementZones must be an array")
        zones = []
    zone_ids: set[str] = set()
    for index, zone in enumerate(zones):
        prefix = f"criticalPlacementZones[{index}]"
        if not isinstance(zone, dict):
            errors.append(f"{prefix} must be an object")
            continue
        zone_id = zone.get("id")
        if not _nonempty(zone_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif zone_id in zone_ids:
            errors.append(f"{prefix}.id duplicates {zone_id!r}")
        else:
            zone_ids.add(str(zone_id))
        for field in ("ownerDesignator", "purpose", "source"):
            if not _nonempty(zone.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        owner_designator = zone.get("ownerDesignator")
        if _nonempty(owner_designator) and owner_designator not in envelope_refs:
            errors.append(
                f"{prefix}.ownerDesignator must match a unique assemblyEnvelopes designator"
            )
        allowed_designators = zone.get("allowedDesignators", [])
        _string_list(errors, f"{prefix}.allowedDesignators", allowed_designators)
        if isinstance(allowed_designators, list):
            for allowed_index, allowed_designator in enumerate(allowed_designators):
                if _nonempty(allowed_designator) and allowed_designator not in envelope_refs:
                    errors.append(
                        f"{prefix}.allowedDesignators[{allowed_index}] must match an "
                        "assemblyEnvelopes designator"
                    )
        geometry = zone.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in {"RECT", "POLYGON"}:
            errors.append(f"{prefix}.geometry must be a RECT or POLYGON object")
        elif geometry.get("type") == "RECT":
            _positive(errors, f"{prefix}.geometry.widthMil", geometry.get("widthMil"))
            _positive(errors, f"{prefix}.geometry.heightMil", geometry.get("heightMil"))
            _optional_finite_geometry_fields(errors, f"{prefix}.geometry", geometry)
        else:
            for field in ("centerXMil", "centerYMil", "rotationDeg"):
                if field in geometry:
                    errors.append(f"{prefix}.geometry.{field} is invalid for POLYGON")
            points = geometry.get("pointsMil")
            if not isinstance(points, list) or len(points) < 3:
                errors.append(f"{prefix}.geometry.pointsMil must contain at least three points")
            else:
                for point_index, point in enumerate(points):
                    if (
                        not isinstance(point, list)
                        or len(point) != 2
                        or any(
                            isinstance(value, bool)
                            or not isinstance(value, (int, float))
                            for value in point
                        )
                    ):
                        errors.append(
                            f"{prefix}.geometry.pointsMil[{point_index}] must be [x, y] numbers"
                        )
                if not _is_simple_nonzero_polygon(points):
                    errors.append(
                        f"{prefix}.geometry.pointsMil must form a simple non-zero-area polygon"
                    )
        if isinstance(geometry, dict) and geometry.get("coordinates", "COMPONENT_LOCAL") not in {
            "COMPONENT_LOCAL",
            "BOARD",
        }:
            errors.append(f"{prefix}.geometry.coordinates must be COMPONENT_LOCAL or BOARD")

    special_vias = record.get("specialViaConstructions")
    if not isinstance(special_vias, list):
        errors.append("specialViaConstructions must be an array")
        special_vias = []
    special_keys: set[tuple[str, str, str]] = set()
    for index, special in enumerate(special_vias):
        prefix = f"specialViaConstructions[{index}]"
        if not isinstance(special, dict):
            errors.append(f"{prefix} must be an object")
            continue
        for field in ("viaPrimitiveId", "padDesignator", "padNumber"):
            if not _nonempty(special.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty exact identifier")
        key = (
            str(special.get("viaPrimitiveId") or ""),
            str(special.get("padDesignator") or ""),
            str(special.get("padNumber") or ""),
        )
        if key in special_keys:
            errors.append(f"{prefix} duplicates an exact via/pad exception")
        special_keys.add(key)
        _enum(
            errors,
            f"{prefix}.construction",
            special.get("construction"),
            SPECIAL_VIA_CONSTRUCTIONS,
        )
        if not _artifact_exists(special.get("processEvidenceArtifact"), base_dir):
            errors.append(f"{prefix}.processEvidenceArtifact must name an existing evidence file")

    human_groups = record.get("humanInterfaceGroups")
    if not isinstance(human_groups, list):
        errors.append("humanInterfaceGroups must be an array")
        human_groups = []
    group_ids: set[str] = set()
    for index, group in enumerate(human_groups):
        prefix = f"humanInterfaceGroups[{index}]"
        if not isinstance(group, dict):
            errors.append(f"{prefix} must be an object")
            continue
        group_id = group.get("id")
        if not _nonempty(group_id):
            errors.append(f"{prefix}.id must be a non-empty string")
        elif group_id in group_ids:
            errors.append(f"{prefix}.id duplicates {group_id!r}")
        else:
            group_ids.add(str(group_id))
        refs = _string_list(errors, f"{prefix}.designators", group.get("designators"))
        if not refs:
            errors.append(f"{prefix}.designators must contain at least one control")
        decision = _enum(
            errors,
            f"{prefix}.decision",
            group.get("decision"),
            HUMAN_INTERFACE_DECISIONS,
        )
        if decision == "GROUP_TOGETHER":
            _positive(errors, f"{prefix}.maxCenterSeparationMil", group.get("maxCenterSeparationMil"))
        elif decision == "SEPARATE_WITH_RATIONALE" and not _nonempty(group.get("rationale")):
            errors.append(f"{prefix}.rationale is required when controls are intentionally separate")
        if not _artifact_exists(group.get("accessEvidenceArtifact"), base_dir):
            errors.append(f"{prefix}.accessEvidenceArtifact must name an existing evidence file")

    interfaces = record.get("externalInterfaces")
    if not isinstance(interfaces, list):
        errors.append("externalInterfaces must be an array")
        interfaces = []
    interface_refs: set[str] = set()
    for index, interface in enumerate(interfaces):
        prefix = f"externalInterfaces[{index}]"
        if not isinstance(interface, dict):
            errors.append(f"{prefix} must be an object")
            continue
        designator = interface.get("designator")
        if not _nonempty(designator):
            errors.append(f"{prefix}.designator must be a non-empty string")
        elif designator in interface_refs:
            errors.append(f"{prefix}.designator duplicates {designator!r}")
        else:
            interface_refs.add(str(designator))
        for field in ("function", "matingPart", "orientation", "rationale", "orderableMpn"):
            if not _nonempty(interface.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        gender = _enum(errors, f"{prefix}.boardGender", interface.get("boardGender"), BOARD_GENDERS)
        if gender not in {"CONTACT_PAD", "INTEGRATED"}:
            _positive(errors, f"{prefix}.pitchMm", interface.get("pitchMm"))
        if not isinstance(interface.get("populated"), bool):
            errors.append(f"{prefix}.populated must be true or false")

    bom_policy = record.get("bomNormalizationPolicy")
    if not isinstance(bom_policy, dict):
        errors.append("bomNormalizationPolicy must be an object")
        bom_policy = {}
    passives = bom_policy.get("passives")
    if not isinstance(passives, dict):
        errors.append("bomNormalizationPolicy.passives must be an object")
        passives = {}
    preferred = passives.get("preferredFootprintsByPrefix")
    if not isinstance(preferred, dict):
        errors.append("bomNormalizationPolicy.passives.preferredFootprintsByPrefix must be an object")
    else:
        for prefix, footprints in preferred.items():
            if not _nonempty(prefix):
                errors.append("passive-package policy prefix must be non-empty")
            _string_list(
                errors,
                f"bomNormalizationPolicy.passives.preferredFootprintsByPrefix.{prefix}",
                footprints,
            )
    passive_exceptions = passives.get("exceptions")
    if not isinstance(passive_exceptions, list):
        errors.append("bomNormalizationPolicy.passives.exceptions must be an array")
        passive_exceptions = []
    passive_exception_refs: set[str] = set()
    for index, exception in enumerate(passive_exceptions):
        prefix = f"bomNormalizationPolicy.passives.exceptions[{index}]"
        if not isinstance(exception, dict):
            errors.append(f"{prefix} must be an object")
            continue
        designator = exception.get("designator")
        for field in ("designator", "orderableMpn", "reason"):
            if not _nonempty(exception.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        if _nonempty(designator):
            if designator in passive_exception_refs:
                errors.append(f"{prefix}.designator duplicates {designator!r}")
            passive_exception_refs.add(str(designator))
    connectors = bom_policy.get("connectors")
    if not isinstance(connectors, dict):
        errors.append("bomNormalizationPolicy.connectors must be an object")
        connectors = {}
    if not isinstance(connectors.get("requireAllJDesignators"), bool):
        errors.append("bomNormalizationPolicy.connectors.requireAllJDesignators must be true or false")
    _string_list(
        errors,
        "bomNormalizationPolicy.connectors.preferredManufacturerSeries",
        connectors.get("preferredManufacturerSeries"),
    )
    connector_exceptions = connectors.get("exceptions")
    if not isinstance(connector_exceptions, list):
        errors.append("bomNormalizationPolicy.connectors.exceptions must be an array")
        connector_exceptions = []
    connector_exception_refs: set[str] = set()
    for index, exception in enumerate(connector_exceptions):
        prefix = f"bomNormalizationPolicy.connectors.exceptions[{index}]"
        if not isinstance(exception, dict):
            errors.append(f"{prefix} must be an object")
            continue
        designator = exception.get("designator")
        for field in ("designator", "reason"):
            if not _nonempty(exception.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        if _nonempty(designator):
            if designator in connector_exception_refs:
                errors.append(f"{prefix}.designator duplicates {designator!r}")
            connector_exception_refs.add(str(designator))

    placement_closure = record.get("placementClosure")
    if not isinstance(placement_closure, dict):
        errors.append("placementClosure must be an object")
    else:
        if placement_closure.get("requiredBeforeRouting") is not True:
            errors.append("placementClosure.requiredBeforeRouting must be true")
        if placement_closure.get("requiredStatus") != "PLACEMENT_CLEAR_FOR_ROUTING":
            errors.append(
                "placementClosure.requiredStatus must be PLACEMENT_CLEAR_FOR_ROUTING"
            )

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
        "constraintBasis": "AUTHORED_BEFORE_PLACEMENT",
        "boardBoundary": {
            "binding": "LIVE_NATIVE",
            "source": "saved/reopened native board-outline readback",
            "outlineLayerId": 11,
            "outerContourPrimitiveId": "outline-main",
            "cutoutPrimitiveIds": [],
            "requireLocked": True,
            "edgeRelations": [],
        },
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
            "validationArtifact": "stackup-validation.json",
            "demandPartitions": {
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
                    "sharedRoleConditions": [
                        "only outside constrained return regions"
                    ],
                },
                "manufacturingMechanical": {
                    "minimumDedicatedLayers": 0,
                    "basis": [
                        "balanced fabricator-supported even-layer construction"
                    ],
                    "sharedRoleConditions": [],
                },
            },
            "decisiveConstraints": ["continuous reference plus routing capacity"],
            "lowerCandidateRejection": [
                {
                    "gate": "ROUTING_CAPACITY",
                    "reason": "two-layer route canary fragments the reference",
                    "evidence": "lower-rejection.json",
                }
            ],
            "nextHigherComparison": "six layers add margin at higher process cost",
            "reserveBasis": "one debug pair and one ECO corridor",
            "assumptions": [],
            "requiredCanaries": [],
            "invalidatedBy": ["outline", "package", "fabricator construction"],
        },
        "layers": [
            {
                "name": "Top Layer",
                "role": "primary-signal",
                "references": [
                    {
                        "layer": "Inner Layer 1",
                        "region": "GND",
                        "continuityEvidence": "top-continuity.json",
                    }
                ],
            },
            {"name": "Inner Layer 1", "role": "continuous-reference"},
            {"name": "Inner Layer 2", "role": "power-distribution"},
            {
                "name": "Bottom Layer",
                "role": "limited-signal",
                "references": [
                    {
                        "layer": "Inner Layer 2",
                        "region": "VDD",
                        "continuityEvidence": "bottom-continuity.json",
                        "highFrequencyReturnEvidence": "bottom-hf-return.json",
                    }
                ],
                "netAllowList": ["GPIO1", "GPIO2"],
            },
        ],
        "routingGeometry": {
            "allowedAnglesDeg": [0, 45, 90, 135],
            "hardRightAngleJunctions": "PROHIBITED_EXCEPT_PAD_OR_VIA",
            "standardVia": {
                "outerDiameterMm": 0.6096,
                "holeDiameterMm": 0.3048,
                "viaToPadCopperClearanceMm": 0.1524,
                "clearanceMeasurement": "COPPER_EDGE_TO_COPPER_EDGE",
                "ruleSource": "fabricator capability revision 1",
            },
        },
        "assembly": {
            "silkscreenToMaskOrPadMm": 0.15,
            "silkscreenRuleSource": "fabricator capability revision 1",
            "bodyToOwnPadPolicy": "EXACT_LAND_PATTERN_AND_FILLET_REVIEW",
            "componentSpacingSource": "assembler package-pair table revision 1",
            "courtyardSource": "verified footprint or sourced constructed courtyard",
            "foreignPadCopperClearanceMm": 0.1524,
            "foreignPadCopperClearanceSource": "fabricator copper clearance rule revision 1",
            "ownPadCourtyardPolicy": "ALL_LIVE_PAD_COPPER_WITHIN_SOURCED_COURTYARD",
            "foreignPadOverlapPolicy": "CHECK_ALL_FOREIGN_PADS_AND_COURTYARDS",
        },
        "assemblyEnvelopes": [
            {
                "designator": "U1",
                "source": "U1 package drawing revision 1",
                "courtyard": {
                    "type": "RECT",
                    "widthMil": 200,
                    "heightMil": 200,
                    "coordinates": "COMPONENT_LOCAL",
                },
            }
        ],
        "criticalPlacementZones": [],
        "specialViaConstructions": [],
        "humanInterfaceGroups": [],
        "externalInterfaces": [],
        "bomNormalizationPolicy": {
            "passives": {
                "preferredFootprintsByPrefix": {"R": ["R0603"], "C": ["C0603"]},
                "exceptions": [],
            },
            "connectors": {
                "requireAllJDesignators": True,
                "preferredManufacturerSeries": [],
                "exceptions": [],
            },
        },
        "placementClosure": {
            "requiredBeforeRouting": True,
            "requiredStatus": "PLACEMENT_CLEAR_FOR_ROUTING",
        },
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

    missing_via_clearance = copy.deepcopy(_base_record())
    missing_via_clearance["routingGeometry"]["standardVia"]["viaToPadCopperClearanceMm"] = None
    cases.append(("missing-via-clearance", missing_via_clearance, "BLOCKED", 2, False))

    missing_foreign_pad_clearance = copy.deepcopy(_base_record())
    missing_foreign_pad_clearance["assembly"]["foreignPadCopperClearanceMm"] = None
    cases.append(
        ("missing-foreign-pad-clearance", missing_foreign_pad_clearance, "BLOCKED", 2, False)
    )

    missing_placement_gate = copy.deepcopy(_base_record())
    del missing_placement_gate["placementClosure"]
    cases.append(("missing-placement-closure", missing_placement_gate, "BLOCKED", 2, False))

    missing_pad_courtyard_policy = copy.deepcopy(_base_record())
    del missing_pad_courtyard_policy["assembly"]["ownPadCourtyardPolicy"]
    cases.append(
        ("missing-own-pad-courtyard-policy", missing_pad_courtyard_policy, "BLOCKED", 2, False)
    )

    missing_foreign_pad_policy = copy.deepcopy(_base_record())
    del missing_foreign_pad_policy["assembly"]["foreignPadOverlapPolicy"]
    cases.append(
        ("missing-foreign-pad-overlap-policy", missing_foreign_pad_policy, "BLOCKED", 2, False)
    )

    invalid_opposite_courtyard = copy.deepcopy(_base_record())
    invalid_opposite_courtyard["assemblyEnvelopes"][0]["oppositeSideCourtyard"] = {
        "type": "RECT",
        "widthMil": 0,
        "heightMil": 100,
        "coordinates": "COMPONENT_LOCAL",
    }
    cases.append(
        ("invalid-opposite-side-courtyard", invalid_opposite_courtyard, "BLOCKED", 2, False)
    )

    invalid_courtyard_center = copy.deepcopy(_base_record())
    invalid_courtyard_center["assemblyEnvelopes"][0]["courtyard"]["centerXMil"] = "100"
    cases.append(
        ("invalid-courtyard-center", invalid_courtyard_center, "BLOCKED", 2, False)
    )

    invalid_opposite_center = copy.deepcopy(_base_record())
    invalid_opposite_center["assemblyEnvelopes"][0]["oppositeSideCourtyard"] = {
        "type": "RECT",
        "widthMil": 20,
        "heightMil": 20,
        "centerYMil": None,
        "coordinates": "COMPONENT_LOCAL",
    }
    cases.append(
        ("invalid-opposite-center", invalid_opposite_center, "BLOCKED", 2, False)
    )

    invalid_opposite_polygon = copy.deepcopy(_base_record())
    invalid_opposite_polygon["assemblyEnvelopes"][0]["oppositeSideCourtyard"] = {
        "type": "POLYGON",
        "pointsMil": [[-50, -50], [50, -50], ["bad", 50]],
        "coordinates": "COMPONENT_LOCAL",
    }
    cases.append(
        ("invalid-opposite-side-polygon", invalid_opposite_polygon, "BLOCKED", 2, False)
    )

    self_intersecting_courtyard = copy.deepcopy(_base_record())
    self_intersecting_courtyard["assemblyEnvelopes"][0]["courtyard"] = {
        "type": "POLYGON",
        "pointsMil": [[-10, -10], [10, 10], [-10, 10], [10, -10]],
        "coordinates": "COMPONENT_LOCAL",
    }
    cases.append(
        ("self-intersecting-courtyard", self_intersecting_courtyard, "BLOCKED", 2, False)
    )

    zero_area_opposite_polygon = copy.deepcopy(_base_record())
    zero_area_opposite_polygon["assemblyEnvelopes"][0]["oppositeSideCourtyard"] = {
        "type": "POLYGON",
        "pointsMil": [[0, 0], [10, 0], [20, 0]],
        "coordinates": "COMPONENT_LOCAL",
    }
    cases.append(
        ("zero-area-opposite-polygon", zero_area_opposite_polygon, "BLOCKED", 2, False)
    )

    repeated_edge_courtyard = copy.deepcopy(_base_record())
    repeated_edge_courtyard["assemblyEnvelopes"][0]["courtyard"] = {
        "type": "POLYGON",
        "pointsMil": [[0, 0], [10, 0], [10, 0], [0, 10]],
        "coordinates": "COMPONENT_LOCAL",
    }
    cases.append(
        ("repeated-edge-courtyard", repeated_edge_courtyard, "BLOCKED", 2, False)
    )

    nonfinite_courtyard = copy.deepcopy(_base_record())
    nonfinite_courtyard["assemblyEnvelopes"][0]["courtyard"] = {
        "type": "POLYGON",
        "pointsMil": [[0, 0], [10, 0], [0, float("nan")]],
        "coordinates": "COMPONENT_LOCAL",
    }
    cases.append(("nonfinite-courtyard", nonfinite_courtyard, "BLOCKED", 2, False))

    self_intersecting_zone = copy.deepcopy(_base_record())
    self_intersecting_zone["criticalPlacementZones"] = [
        {
            "id": "bow-tie-zone",
            "ownerDesignator": "U1",
            "purpose": "self-test",
            "source": "self-test",
            "allowedDesignators": [],
            "geometry": {
                "type": "POLYGON",
                "pointsMil": [[-10, -10], [10, 10], [-10, 10], [10, -10]],
                "coordinates": "COMPONENT_LOCAL",
            },
        }
    ]
    cases.append(("self-intersecting-zone", self_intersecting_zone, "BLOCKED", 2, False))

    missing_zone_owner = copy.deepcopy(_base_record())
    missing_zone_owner["criticalPlacementZones"] = [
        {
            "id": "ghost-owner-zone",
            "ownerDesignator": "GHOST",
            "purpose": "self-test",
            "source": "self-test",
            "allowedDesignators": [],
            "geometry": {
                "type": "RECT",
                "widthMil": 20,
                "heightMil": 20,
                "coordinates": "BOARD",
            },
        }
    ]
    cases.append(("missing-zone-owner", missing_zone_owner, "BLOCKED", 2, False))

    missing_allowed_designator = copy.deepcopy(_base_record())
    missing_allowed_designator["criticalPlacementZones"] = [
        {
            "id": "ghost-allowed-zone",
            "ownerDesignator": "U1",
            "purpose": "self-test",
            "source": "self-test",
            "allowedDesignators": ["GHOST"],
            "geometry": {
                "type": "RECT",
                "widthMil": 20,
                "heightMil": 20,
                "coordinates": "COMPONENT_LOCAL",
            },
        }
    ]
    cases.append(
        ("missing-zone-allowed-designator", missing_allowed_designator, "BLOCKED", 2, False)
    )

    invalid_zone_rotation = copy.deepcopy(_base_record())
    invalid_zone_rotation["criticalPlacementZones"] = [
        {
            "id": "invalid-zone-rotation",
            "ownerDesignator": "U1",
            "purpose": "self-test",
            "source": "self-test",
            "allowedDesignators": [],
            "geometry": {
                "type": "RECT",
                "widthMil": 20,
                "heightMil": 20,
                "rotationDeg": True,
                "coordinates": "COMPONENT_LOCAL",
            },
        }
    ]
    cases.append(("invalid-zone-rotation", invalid_zone_rotation, "BLOCKED", 2, False))

    invalid_bottom_transform = copy.deepcopy(_base_record())
    invalid_bottom_transform["assemblyEnvelopes"][0]["courtyard"][
        "bottomSideTransform"
    ] = "MIRROR_UNSPECIFIED"
    cases.append(
        ("invalid-bottom-transform", invalid_bottom_transform, "BLOCKED", 2, False)
    )

    invalid_padstack_evidence = copy.deepcopy(_base_record())
    invalid_padstack_evidence["assemblyEnvelopes"][0]["padstackProjectionEvidence"] = [
        {"padNumber": "1", "policy": "TOP_LAYER_ONLY", "source": "self-test"}
    ]
    cases.append(
        ("invalid-padstack-projection", invalid_padstack_evidence, "BLOCKED", 2, False)
    )

    invalid_special_via = copy.deepcopy(_base_record())
    invalid_special_via["specialViaConstructions"] = [
        {
            "viaPrimitiveId": "via-1",
            "padDesignator": "U1",
            "padNumber": "1",
            "construction": "ORDINARY_UNFILLED",
            "processEvidenceArtifact": None,
        }
    ]
    cases.append(("invalid-special-via", invalid_special_via, "BLOCKED", 2, False))

    planning_bound = copy.deepcopy(_base_record())
    planning_bound["revision"] = "planning:sha256:" + "a" * 64
    planning_bound["planningRevision"] = {
        "projectUuid": "project-uuid",
        "schematicPageUuid": "schematic-page-uuid",
        "schematicFingerprint": "sha256:" + "b" * 64,
        "outlineCandidateId": "outline-a",
        "footprintSetFingerprint": "sha256:" + "c" * 64,
        "interfaceDecisionFingerprint": "sha256:" + "d" * 64,
        "processProfileFingerprint": "sha256:" + "e" * 64,
    }
    cases.append(
        ("planning-revision-bound", planning_bound, "CLEARED_FOR_PLACEMENT", 0, True)
    )

    planning_unbound = copy.deepcopy(_base_record())
    planning_unbound["revision"] = "planning:sha256:" + "a" * 64
    cases.append(("planning-revision-unbound", planning_unbound, "BLOCKED", 2, False))

    missing_decisive = copy.deepcopy(_base_record())
    missing_decisive["layerCountDecision"]["decisiveConstraints"] = []
    cases.append(("missing-decisive-constraint", missing_decisive, "BLOCKED", 2, False))

    missing_reference = copy.deepcopy(_base_record())
    del missing_reference["layers"][0]["references"]
    cases.append(("missing-layer-reference", missing_reference, "BLOCKED", 2, False))

    duplicate_reference = copy.deepcopy(_base_record())
    duplicate_reference["layers"][0]["references"].append(
        copy.deepcopy(duplicate_reference["layers"][0]["references"][0])
    )
    cases.append(("duplicate-layer-reference", duplicate_reference, "BLOCKED", 2, False))

    unlimited_layer = copy.deepcopy(_base_record())
    del unlimited_layer["layers"][3]["netAllowList"]
    cases.append(("unbounded-limited-layer", unlimited_layer, "BLOCKED", 2, False))

    malformed_partition = copy.deepcopy(_base_record())
    malformed_partition["layerCountDecision"]["demandPartitions"]["routingEscape"] = (
        "free-form summary"
    )
    cases.append(("malformed-demand-partition", malformed_partition, "BLOCKED", 2, False))

    missing_basis = copy.deepcopy(_base_record())
    del missing_basis["constraintBasis"]
    cases.append(("missing-constraint-basis", missing_basis, "BLOCKED", 2, False))

    invalid_basis = copy.deepcopy(_base_record())
    invalid_basis["constraintBasis"] = "DERIVED_FROM_LAYOUT"
    cases.append(("invalid-constraint-basis", invalid_basis, "BLOCKED", 2, False))

    missing_board_boundary = copy.deepcopy(_base_record())
    del missing_board_boundary["boardBoundary"]
    cases.append(("missing-board-boundary", missing_board_boundary, "BLOCKED", 2, False))

    unlocked_board_boundary = copy.deepcopy(_base_record())
    unlocked_board_boundary["boardBoundary"]["requireLocked"] = False
    cases.append(("unlocked-board-boundary", unlocked_board_boundary, "BLOCKED", 2, False))

    invalid_edge_relation = copy.deepcopy(_base_record())
    invalid_edge_relation["boardBoundary"]["edgeRelations"] = [
        {
            "subjectType": "CRITICAL_ZONE",
            "subjectId": "U1_ANTENNA",
            "relation": "ALLOWED_OVERHANG",
            "source": "module integration drawing",
            "evidenceArtifact": None,
        }
    ]
    cases.append(("invalid-edge-relation", invalid_edge_relation, "BLOCKED", 2, False))

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

    with tempfile.TemporaryDirectory(prefix="easyeda-constraint-lint-") as temp_name:
        temp_dir = Path(temp_name)
        bound = _base_record()
        stackup_module = _load_stackup_module()
        candidate = copy.deepcopy(stackup_module._baseline_record())
        candidate["revision"] = bound["revision"]
        bound["layers"] = copy.deepcopy(candidate["candidates"][1]["layerFunctions"])
        bound["layerCountDecision"]["demandPartitions"] = copy.deepcopy(
            candidate["demandPartitions"]
        )
        for artifact_name in (
            "floorplan.json",
            "lower-rejection.json",
        ):
            (temp_dir / artifact_name).write_text("{}\n", encoding="utf-8")

        def materialize_stackup_artifacts(value: Any) -> None:
            if isinstance(value, dict):
                for child in value.values():
                    materialize_stackup_artifacts(child)
            elif isinstance(value, list):
                for child in value:
                    materialize_stackup_artifacts(child)
            elif isinstance(value, str) and value.startswith("evidence/"):
                artifact_path = temp_dir / value
                artifact_path.parent.mkdir(parents=True, exist_ok=True)
                artifact_path.write_text("{}\n", encoding="utf-8")

        materialize_stackup_artifacts(candidate)
        candidate_bytes = (
            json.dumps(candidate, indent=2, ensure_ascii=False) + "\n"
        ).encode("utf-8")
        (temp_dir / "stackup-candidates.json").write_bytes(candidate_bytes)
        validation = stackup_module.validate_stackup_decision(candidate, base_dir=temp_dir)
        if validation.get("consistent") is not True:
            print("self-test source stackup record failed", file=sys.stderr)
            print(json.dumps(validation, indent=2, ensure_ascii=False), file=sys.stderr)
            return 1
        validation["decisionRecordFingerprint"] = (
            "sha256:" + hashlib.sha256(candidate_bytes).hexdigest()
        )
        (temp_dir / "stackup-validation.json").write_text(
            json.dumps(validation, indent=2) + "\n", encoding="utf-8"
        )
        bound_report = validate_constraint_record(bound, base_dir=temp_dir)
        if not bound_report["consistent"] or bound_report["gateStatus"] != "CLEARED_FOR_PLACEMENT":
            print("self-test bound-stackup-report failed", file=sys.stderr)
            print(json.dumps(bound_report, indent=2, ensure_ascii=False), file=sys.stderr)
            return 1
        partition_mismatch = copy.deepcopy(bound)
        partition_mismatch["layerCountDecision"]["demandPartitions"]["routingEscape"][
            "minimumDedicatedLayers"
        ] += 1
        mismatch_report = validate_constraint_record(partition_mismatch, base_dir=temp_dir)
        if mismatch_report["consistent"] or not any(
            "demandPartitions do not match" in error
            for error in mismatch_report["errors"]
        ):
            print("self-test demand-partition-binding failed", file=sys.stderr)
            print(json.dumps(mismatch_report, indent=2, ensure_ascii=False), file=sys.stderr)
            return 1
        (temp_dir / "stackup-candidates.json").write_text(
            '{"kind":"changed-after-validation"}\n', encoding="utf-8"
        )
        stale_report = validate_constraint_record(bound, base_dir=temp_dir)
        if stale_report["consistent"] or not any(
            "stale for candidateComparisonArtifact" in error
            for error in stale_report["errors"]
        ):
            print("self-test stale-stackup-binding failed", file=sys.stderr)
            print(json.dumps(stale_report, indent=2, ensure_ascii=False), file=sys.stderr)
            return 1
    print(
        f"easyeda_constraint_lint self-test passed ({len(cases)} state cases + binding cases)"
    )
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
