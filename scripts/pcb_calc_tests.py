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

    def test_rejects_unphysical_geometry(self):
        with self.assertRaises(ValueError):
            pcb_calc.microstrip(4.1, 0.18, 0.25, 0.18)
        with self.assertRaises(ValueError):
            pcb_calc.stripline(4.1, 0.3, 0.1, 0.15)
        with self.assertRaises(ValueError):
            pcb_calc.via_estimate(1.6, 0.3, 1.7, 4.1, 5.0, None)


if __name__ == "__main__":
    unittest.main()
