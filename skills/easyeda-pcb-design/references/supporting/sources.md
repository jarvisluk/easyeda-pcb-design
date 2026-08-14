# Sources and attribution

## Contents

- [Implementation provenance](#implementation-provenance)
- [Engineering-practice source](#engineering-practice-source)
- [Equation families](#equation-families)
- [Power, mixed-signal, BGA, and stackup](#power-mixed-signal-bga-and-stackup)
- [Onboard antennas](#onboard-antennas)
- [Manufacturing and assembly](#manufacturing-and-assembly)

## Implementation provenance

This skill is an independent EasyEDA implementation. Its workflow decomposition was informed by:

- MathWorks MATLAB Agentic Toolkit `matlab-design-pcb-txline`
  - https://github.com/matlab/matlab-agentic-toolkit/tree/main/skills-catalog/rf-and-mixed-signal/matlab-design-pcb-txline
- MathWorks MATLAB Agentic Toolkit `matlab-model-via`
  - https://github.com/matlab/matlab-agentic-toolkit/tree/main/skills-catalog/rf-and-mixed-signal/matlab-model-via
- MathWorks MATLAB Agentic Toolkit `matlab-manage-pcb-material`
  - https://github.com/matlab/matlab-agentic-toolkit/tree/main/skills-catalog/rf-and-mixed-signal/matlab-manage-pcb-material
- MathWorks MATLAB Agentic Toolkit `matlab-analyze-em`
  - https://github.com/matlab/matlab-agentic-toolkit/tree/main/skills-catalog/rf-and-mixed-signal/matlab-analyze-em
- EasyEDA API Skill
  - https://github.com/easyeda/easyeda-api-skill

Copyright 2026 The MathWorks, Inc. The referenced MathWorks skill repository has its own license and usage conditions. No MATLAB or RF PCB Toolbox solver implementation is copied into this skill.

The analytical equations in `scripts/calc/pcb_calc.py` are independently implemented
conventional closed-form engineering approximations. They are not substitutes
for MathWorks products, a fabrication-house field solver, or laboratory
measurement.

## Engineering-practice source

- 田学军，《高速PCB设计经验规则应用实践》，清华大学出版社，2024，
  ISBN 978-7-302-67231-9。

This book was used as a source of candidate heuristic categories and teaching
structure. Its rules were not copied as universal numeric requirements. Each
retained heuristic in this skill is expressed as a governed constraint with
scope, assumptions, tradeoffs, invalidation conditions, and an evidence gate.
The worked example is an original composite example, not a reproduction of a
book design. The reviewed EPUB did not provide a detailed bibliography suitable
for numeric authority, so consequential values must be rebound to primary
device, interface, fabricator, or measurement sources.

## Equation families

Equation-family references and cross-check sources:

- E. Hammerstad and Ø. Jensen, “Accurate Models for Microstrip
  Computer-Aided Design,” IEEE MTT-S International Microwave Symposium Digest,
  1980, pp. 407–409, DOI: `10.1109/MWSYM.1980.1124303`.
- Keysight Technologies, “RF Design Software Learning Kit,” application note
  5992-2079, for an independent commercial-tool description of the
  Hammerstad/Jensen model family.
- AMD/Xilinx, “Signal Integrity,” July 2005, for the first-order cylindrical
  via-inductance screening equation and its limitations in PCB use.

The edge-rate, uniform-trace DC, and skin-depth commands use elementary
propagation, Ohm-law geometry, and classical conductor equations. Their printed
constants and assumptions are part of the result contract; they are screens,
not release evidence.

## Power, mixed-signal, BGA, and stackup

- Texas Instruments, SLVAFJ3, “Layout Optimization of 4-Switch Buck-Boost
  Converters,” for topology-aware switching-loop and placement analysis:
  https://www.ti.com/lit/an/slvafj3/slvafj3.pdf
- AMD, UG863, “Target Impedance,” for PDN target-impedance methodology:
  https://docs.amd.com/r/en-US/ug863-versal-pcb-design/Target-Impedance
- Analog Devices, MT-031, “Grounding Data Converters and Solving the Mystery of
  AGND and DGND,” for converter-grounding decisions:
  https://www.analog.com/media/en/training-seminars/tutorials/MT-031.pdf
- Analog Devices, “What are the Basic Guidelines for Layout Design of Mixed
  Signal PCBs?”, for return-current-oriented mixed-signal partitioning:
  https://www.analog.com/en/resources/analog-dialogue/articles/what-are-the-basic-guidelines-for-layout-design-of-mixed-signal-pcbs.html
- Texas Instruments, SPRUIP9, “AM570x BGA PCB Design,” for package-specific BGA
  escape and board-technology planning:
  https://www.ti.com/lit/ug/spruip9/spruip9.pdf
- Texas Instruments, SPRABB3, “PCB Design Guidelines for 0.5-mm Package-on-
  Package Applications,” for fine-pitch routing and fabrication constraints:
  https://www.ti.com/lit/an/sprabb3/sprabb3.pdf
- Intel, “IA PCB Stack-up Overview,” for layer-role, reference-plane, material,
  and fabrication-construction planning:
  https://www.intel.com/content/dam/www/public/us/en/documents/white-papers/ia-pcb-stack-up-overview.pdf

These are methodology references. Exact component, package, interface, and
fabrication revisions remain the governing sources for a specific board.

## Onboard antennas

- Espressif Systems, “ESP Hardware Design Guidelines — PCB Layout Design,”
  especially the current module-on-base-board placement and PCB-antenna/RF
  layout sections:
  https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c5/pcb-layout-design.html
- Texas Instruments, AN058 / SWRA161B, “Antenna Selection Guide,” for ground,
  enclosure, matching, VNA, and OTA considerations:
  https://www.ti.com/lit/an/swra161b/swra161b.pdf
- Texas Instruments, AN043 / SWRA117D, “Small Size 2.4 GHz PCB Antenna,” as an
  example of an antenna whose released geometry, ground, and measured reference
  implementation must be treated as a coupled design:
  https://www.ti.com/lit/an/swra117d/swra117d.pdf
- Nordic Semiconductor, nRF52832 Product Specification, “Reference circuitry —
  PCB guidelines,” for RF matching-layout and multilayer keepout guidance:
  https://docs.nordicsemi.com/r/bundle/ps_nrf52832/page/ref_circuitry.html

## Manufacturing and assembly

- JLCPCB, “PCB Manufacturing & Assembly Capabilities,” for current legend,
  solder-mask, copper, drill, and outline capabilities:
  https://jlcpcb.com/capabilities/Capabilities
- JLCPCB, “Minimum Spacing Requirements for SMD Components,” for its current
  package-pair assembly spacing table:
  https://jlcpcb.com/help/article/minimum-spacing-for-smd-components
- JLCPCB, “Terms and Conditions of JLCPCB Assembly Service,” for its stated
  IPC-7351B density and non-overlap expectations:
  https://jlcpcb.com/help/article/terms-and-conditions-of-jlcpcb-assembly-service
