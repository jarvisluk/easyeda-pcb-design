#!/usr/bin/env python3

import math
import unittest

import pcb_calc


class PcbCalcTests(unittest.TestCase):
    def test_microstrip_golden_vector(self):
        result = pcb_calc.microstrip(4.1, 0.18, 0.33, 0.035)
        self.assertAlmostEqual(result.impedance_ohm, 50.287797, places=5)
        self.assertAlmostEqual(result.effective_er, 3.13858, places=5)
        self.assertEqual(result.evidence, "ANALYTICAL_ESTIMATE")

    def test_diff_microstrip_golden_vector(self):
        result = pcb_calc.diff_microstrip(4.1, 0.18, 0.25, 0.18, 0.035)
        self.assertAlmostEqual(result["differential_impedance_ohm"], 95.083989, places=5)
        self.assertAlmostEqual(result["odd_mode_impedance_ohm"], 47.541994, places=5)

    def test_impedance_decreases_as_width_increases(self):
        narrow = pcb_calc.microstrip(4.1, 0.18, 0.15, 0.035)
        wide = pcb_calc.microstrip(4.1, 0.18, 0.35, 0.035)
        self.assertGreater(narrow.impedance_ohm, wide.impedance_ohm)

    def test_diff_impedance_increases_as_pair_spacing_increases(self):
        close = pcb_calc.diff_microstrip(4.1, 0.18, 0.25, 0.1, 0.035)
        far = pcb_calc.diff_microstrip(4.1, 0.18, 0.25, 0.3, 0.035)
        self.assertLess(
            close["differential_impedance_ohm"],
            far["differential_impedance_ohm"],
        )

    def test_width_solver_hits_target(self):
        width, result = pcb_calc.solve_width(
            lambda candidate: vars(
                pcb_calc.microstrip(4.1, 0.18, candidate, 0.035)
            ),
            50,
            0.18,
        )
        self.assertGreater(width, 0)
        self.assertAlmostEqual(result["impedance_ohm"], 50, places=6)

    def test_via_golden_vector(self):
        result = pcb_calc.via_estimate(1.6, 0.3, 1.0, 4.1, 5.0, 1.0)
        self.assertAlmostEqual(result["barrel_inductance_nh"], 1.299287, places=5)
        self.assertAlmostEqual(
            result["quarter_wave_stub_resonance_ghz"],
            37.014235,
            places=5,
        )
        self.assertTrue(math.isfinite(result["dielectric_wavelength_mm"]))

    def test_edge_screening_golden_vector_and_classification(self):
        result = pcb_calc.edge_screening(1.0, 25.0, 4.0)
        self.assertAlmostEqual(result["one_way_delay_ps"], 166.782048, places=5)
        self.assertAlmostEqual(result["gaussian_3db_bandwidth_ghz"], 0.35)
        self.assertEqual(result["classification"], "transmission_line_review")

    def test_edge_screening_shorter_route_reduces_ratio(self):
        short = pcb_calc.edge_screening(1.0, 5.0, 4.0)
        long = pcb_calc.edge_screening(1.0, 25.0, 4.0)
        self.assertLess(
            short["flight_time_to_rise_time"],
            long["flight_time_to_rise_time"],
        )

    def test_trace_dc_golden_vector_and_current_outputs(self):
        result = pcb_calc.trace_dc(100.0, 0.25, 0.035, 20.0, 1.0)
        self.assertAlmostEqual(result["resistance_ohm"], 0.19704, places=5)
        self.assertAlmostEqual(result["voltage_drop_v"], 0.19704, places=5)
        self.assertAlmostEqual(result["power_loss_w"], 0.19704, places=5)

    def test_trace_dc_resistance_increases_with_temperature(self):
        cold = pcb_calc.trace_dc(100.0, 0.25, 0.035, 20.0)
        hot = pcb_calc.trace_dc(100.0, 0.25, 0.035, 80.0)
        self.assertGreater(hot["resistance_ohm"], cold["resistance_ohm"])

    def test_skin_depth_golden_vector_and_frequency_trend(self):
        low = pcb_calc.skin_depth(1.0)
        high = pcb_calc.skin_depth(4.0)
        self.assertAlmostEqual(low["skin_depth_um"], 2.089807, places=5)
        self.assertAlmostEqual(high["skin_depth_um"], low["skin_depth_um"] / 2.0)

    def test_rejects_unphysical_geometry(self):
        with self.assertRaises(ValueError):
            pcb_calc.microstrip(4.1, 0.18, 0.25, 0.18)
        with self.assertRaises(ValueError):
            pcb_calc.stripline(4.1, 0.3, 0.1, 0.15)
        with self.assertRaises(ValueError):
            pcb_calc.via_estimate(1.6, 0.3, 1.7, 4.1, 5.0, None)
        with self.assertRaises(ValueError):
            pcb_calc.edge_screening(0.0, 10.0, 4.1)
        with self.assertRaises(ValueError):
            pcb_calc.trace_dc(10.0, 0.2, 0.0)
        with self.assertRaises(ValueError):
            pcb_calc.skin_depth(0.0)


if __name__ == "__main__":
    unittest.main()
