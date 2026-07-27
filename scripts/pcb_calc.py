#!/usr/bin/env python3
"""Closed-form PCB transmission-line and via screening calculations.

The results are analytical estimates, not field-solver or measurement evidence.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass

C0 = 299_792_458.0


def positive(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("value must be a positive finite number")
    return number


def nonnegative(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise argparse.ArgumentTypeError("value must be a nonnegative finite number")
    return number


@dataclass
class MicrostripResult:
    model: str
    evidence: str
    impedance_ohm: float
    effective_er: float
    delay_ps_per_mm: float
    effective_width_mm: float
    assumptions: list[str]


def _coth(x: float) -> float:
    return math.cosh(x) / math.sinh(x)


def _finite_thickness_u(u: float, t_over_h: float, er: float) -> float:
    if t_over_h <= 0:
        return u
    coth_term = _coth(math.sqrt(6.517 * u))
    delta_u1 = (t_over_h / math.pi) * math.log(
        1.0 + (4.0 * math.e) / (t_over_h * coth_term * coth_term)
    )
    delta_u = delta_u1 * (1.0 + 1.0 / math.cosh(math.sqrt(er - 1.0))) / 2.0
    return u + delta_u


def microstrip(er: float, height_mm: float, width_mm: float, thickness_mm: float) -> MicrostripResult:
    if er <= 1:
        raise ValueError("relative permittivity must be greater than 1")
    if height_mm <= 0 or width_mm <= 0 or thickness_mm < 0:
        raise ValueError("microstrip dimensions must be positive and thickness nonnegative")
    if thickness_mm >= height_mm:
        raise ValueError("copper thickness must be smaller than dielectric height")

    u = width_mm / height_mm
    u_eff = _finite_thickness_u(u, thickness_mm / height_mm, er)

    a = (
        1.0
        + math.log((u_eff**4 + (u_eff / 52.0) ** 2) / (u_eff**4 + 0.432)) / 49.0
        + math.log(1.0 + (u_eff / 18.1) ** 3) / 18.7
    )
    b = 0.564 * ((er - 0.9) / (er + 3.0)) ** 0.053
    effective_er = (er + 1.0) / 2.0 + (er - 1.0) / 2.0 * (1.0 + 10.0 / u_eff) ** (-a * b)
    f_u = 6.0 + (2.0 * math.pi - 6.0) * math.exp(-(30.666 / u_eff) ** 0.7528)
    impedance = (60.0 / math.sqrt(effective_er)) * math.log(
        f_u / u_eff + math.sqrt(1.0 + (2.0 / u_eff) ** 2)
    )
    delay = math.sqrt(effective_er) / C0 * 1e9
    return MicrostripResult(
        model="quasi_static_microstrip",
        evidence="ANALYTICAL_ESTIMATE",
        impedance_ohm=impedance,
        effective_er=effective_er,
        delay_ps_per_mm=delay,
        effective_width_mm=u_eff * height_mm,
        assumptions=[
            "uniform cross-section and continuous reference plane",
            "frequency-independent bulk Dk",
            "no soldermask, copper roughness, weave, or etch compensation",
        ],
    )


def diff_microstrip(
    er: float,
    height_mm: float,
    width_mm: float,
    spacing_mm: float,
    thickness_mm: float,
) -> dict:
    if spacing_mm <= 0:
        raise ValueError("edge-to-edge spacing must be positive")
    single = microstrip(er, height_mm, width_mm, thickness_mm)
    coupling = 0.48 * math.exp(-0.96 * spacing_mm / height_mm)
    z_diff = 2.0 * single.impedance_ohm * (1.0 - coupling)
    return {
        "model": "edge_coupled_microstrip",
        "evidence": "ANALYTICAL_ESTIMATE",
        "differential_impedance_ohm": z_diff,
        "odd_mode_impedance_ohm": z_diff / 2.0,
        "uncoupled_single_ended_impedance_ohm": single.impedance_ohm,
        "effective_er": single.effective_er,
        "delay_ps_per_mm": single.delay_ps_per_mm,
        "effective_width_mm": single.effective_width_mm,
        "assumptions": single.assumptions
        + [
            "identical pair members with constant edge-to-edge spacing",
            "empirical edge-coupling correction; no launch or bend discontinuities",
        ],
    }


def stripline(er: float, plane_spacing_mm: float, width_mm: float, thickness_mm: float) -> dict:
    if er <= 1:
        raise ValueError("relative permittivity must be greater than 1")
    if plane_spacing_mm <= 0 or width_mm <= 0 or thickness_mm < 0:
        raise ValueError("stripline dimensions must be positive and thickness nonnegative")
    if thickness_mm >= plane_spacing_mm / 2:
        raise ValueError("copper thickness must be smaller than the nearest-plane distance")
    denominator = 0.67 * math.pi * (0.8 * width_mm + thickness_mm)
    ratio = 4.0 * plane_spacing_mm / denominator
    if ratio <= 1:
        raise ValueError("geometry is outside the symmetric stripline approximation range")
    impedance = 60.0 / math.sqrt(er) * math.log(ratio)
    delay = math.sqrt(er) / C0 * 1e9
    return {
        "model": "symmetric_stripline",
        "evidence": "ANALYTICAL_ESTIMATE",
        "impedance_ohm": impedance,
        "effective_er": er,
        "delay_ps_per_mm": delay,
        "assumptions": [
            "trace centered between parallel reference planes",
            "uniform isotropic dielectric",
            "no copper roughness, weave, or etch compensation",
        ],
    }


def diff_stripline(
    er: float,
    plane_spacing_mm: float,
    width_mm: float,
    spacing_mm: float,
    thickness_mm: float,
) -> dict:
    if spacing_mm <= 0:
        raise ValueError("edge-to-edge spacing must be positive")
    single = stripline(er, plane_spacing_mm, width_mm, thickness_mm)
    nearest_plane_mm = plane_spacing_mm / 2.0
    coupling = 0.347 * math.exp(-2.9 * spacing_mm / nearest_plane_mm)
    z_diff = 2.0 * single["impedance_ohm"] * (1.0 - coupling)
    return {
        "model": "edge_coupled_symmetric_stripline",
        "evidence": "ANALYTICAL_ESTIMATE",
        "differential_impedance_ohm": z_diff,
        "odd_mode_impedance_ohm": z_diff / 2.0,
        "uncoupled_single_ended_impedance_ohm": single["impedance_ohm"],
        "effective_er": er,
        "delay_ps_per_mm": single["delay_ps_per_mm"],
        "assumptions": single["assumptions"]
        + ["identical pair members and empirical edge-coupling correction"],
    }


def solve_width(function, target_ohm: float, height_mm: float) -> tuple[float, dict]:
    low = height_mm * 0.01
    high = height_mm * 20.0
    low_value = function(low)
    high_value = function(high)
    value_key = (
        "differential_impedance_ohm"
        if "differential_impedance_ohm" in low_value
        else "impedance_ohm"
    )
    if not (high_value[value_key] <= target_ohm <= low_value[value_key]):
        raise ValueError(
            f"target {target_ohm:g} ohm is outside the model range "
            f"[{high_value[value_key]:.3f}, {low_value[value_key]:.3f}]"
        )
    for _ in range(100):
        mid = (low + high) / 2.0
        result = function(mid)
        if result[value_key] > target_ohm:
            low = mid
        else:
            high = mid
    width = (low + high) / 2.0
    return width, function(width)


def via_estimate(
    board_thickness_mm: float,
    drill_mm: float,
    stub_mm: float,
    er: float,
    frequency_ghz: float,
    return_via_distance_mm: float | None,
) -> dict:
    if er <= 1:
        raise ValueError("relative permittivity must be greater than 1")
    if board_thickness_mm <= 0 or drill_mm <= 0 or stub_mm < 0:
        raise ValueError("via dimensions must be positive and stub nonnegative")
    if stub_mm > board_thickness_mm:
        raise ValueError("unused stub cannot exceed the via barrel length")
    if drill_mm >= board_thickness_mm * 4:
        raise ValueError("drill diameter is implausibly large relative to via length")
    if return_via_distance_mm is not None and return_via_distance_mm <= 0:
        raise ValueError("return-via distance must be positive")

    h_in = board_thickness_mm / 25.4
    d_in = drill_mm / 25.4
    barrel_inductance_nh = 5.08 * h_in * (math.log(4.0 * h_in / d_in) + 1.0)
    frequency_hz = frequency_ghz * 1e9
    wavelength_mm = C0 / (frequency_hz * math.sqrt(er)) * 1000.0
    stub_resonance_ghz = None
    if stub_mm > 0:
        stub_resonance_ghz = C0 / (4.0 * stub_mm / 1000.0 * math.sqrt(er)) / 1e9

    result = {
        "model": "via_screening",
        "evidence": "ANALYTICAL_ESTIMATE",
        "barrel_inductance_nh": barrel_inductance_nh,
        "quarter_wave_stub_resonance_ghz": stub_resonance_ghz,
        "dielectric_wavelength_mm": wavelength_mm,
        "assumptions": [
            "straight cylindrical plated through via",
            "uniform dielectric and no pad/antipad capacitance",
            "stub resonance uses a quarter-wave screening approximation",
        ],
    }
    if return_via_distance_mm is not None:
        fraction = return_via_distance_mm / wavelength_mm
        if fraction <= 1 / 20:
            rating = "preferred"
        elif fraction <= 1 / 10:
            rating = "review"
        else:
            rating = "high_risk"
        result["return_via"] = {
            "distance_mm": return_via_distance_mm,
            "wavelength_fraction": fraction,
            "rating": rating,
        }
    return result


def rounded(value):
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {key: rounded(item) for key, item in value.items()}
    if isinstance(value, list):
        return [rounded(item) for item in value]
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analytical PCB impedance and via screening calculator"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_microstrip_args(p):
        p.add_argument("--er", type=positive, required=True)
        p.add_argument("--height-mm", type=positive, required=True)
        p.add_argument("--width-mm", type=positive, required=True)
        p.add_argument("--thickness-mm", type=nonnegative, default=0.035)

    p = sub.add_parser("microstrip")
    add_microstrip_args(p)

    p = sub.add_parser("diff-microstrip")
    add_microstrip_args(p)
    p.add_argument("--spacing-mm", type=positive, required=True)

    p = sub.add_parser("solve-microstrip")
    p.add_argument("--er", type=positive, required=True)
    p.add_argument("--height-mm", type=positive, required=True)
    p.add_argument("--target-ohm", type=positive, required=True)
    p.add_argument("--thickness-mm", type=nonnegative, default=0.035)

    p = sub.add_parser("solve-diff-microstrip")
    p.add_argument("--er", type=positive, required=True)
    p.add_argument("--height-mm", type=positive, required=True)
    p.add_argument("--spacing-mm", type=positive, required=True)
    p.add_argument("--target-ohm", type=positive, required=True)
    p.add_argument("--thickness-mm", type=nonnegative, default=0.035)

    p = sub.add_parser("stripline")
    p.add_argument("--er", type=positive, required=True)
    p.add_argument("--plane-spacing-mm", type=positive, required=True)
    p.add_argument("--width-mm", type=positive, required=True)
    p.add_argument("--thickness-mm", type=nonnegative, default=0.035)

    p = sub.add_parser("diff-stripline")
    p.add_argument("--er", type=positive, required=True)
    p.add_argument("--plane-spacing-mm", type=positive, required=True)
    p.add_argument("--width-mm", type=positive, required=True)
    p.add_argument("--spacing-mm", type=positive, required=True)
    p.add_argument("--thickness-mm", type=nonnegative, default=0.035)

    p = sub.add_parser("via")
    p.add_argument("--board-thickness-mm", type=positive, required=True)
    p.add_argument("--drill-mm", type=positive, required=True)
    p.add_argument("--stub-mm", type=nonnegative, default=0.0)
    p.add_argument("--er", type=positive, required=True)
    p.add_argument("--frequency-ghz", type=positive, required=True)
    p.add_argument("--return-via-distance-mm", type=positive)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "microstrip":
            result = asdict(
                microstrip(args.er, args.height_mm, args.width_mm, args.thickness_mm)
            )
        elif args.command == "diff-microstrip":
            result = diff_microstrip(
                args.er,
                args.height_mm,
                args.width_mm,
                args.spacing_mm,
                args.thickness_mm,
            )
        elif args.command == "solve-microstrip":
            width, result = solve_width(
                lambda w: asdict(
                    microstrip(args.er, args.height_mm, w, args.thickness_mm)
                ),
                args.target_ohm,
                args.height_mm,
            )
            result = {"solved_width_mm": width, **result}
        elif args.command == "solve-diff-microstrip":
            width, result = solve_width(
                lambda w: diff_microstrip(
                    args.er, args.height_mm, w, args.spacing_mm, args.thickness_mm
                ),
                args.target_ohm,
                args.height_mm,
            )
            result = {"solved_width_mm": width, **result}
        elif args.command == "stripline":
            result = stripline(
                args.er, args.plane_spacing_mm, args.width_mm, args.thickness_mm
            )
        elif args.command == "diff-stripline":
            result = diff_stripline(
                args.er,
                args.plane_spacing_mm,
                args.width_mm,
                args.spacing_mm,
                args.thickness_mm,
            )
        elif args.command == "via":
            result = via_estimate(
                args.board_thickness_mm,
                args.drill_mm,
                args.stub_mm,
                args.er,
                args.frequency_ghz,
                args.return_via_distance_mm,
            )
        else:
            raise AssertionError("unreachable")
    except ValueError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2

    print(json.dumps(rounded(result), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
