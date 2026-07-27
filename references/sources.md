# Sources and attribution

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

The analytical equations in `scripts/pcb_calc.py` are independently implemented conventional closed-form engineering approximations. They are not substitutes for MathWorks products, a fabrication-house field solver, or laboratory measurement.

Equation-family references and cross-check sources:

- E. Hammerstad and Ø. Jensen, “Accurate Models for Microstrip
  Computer-Aided Design,” IEEE MTT-S International Microwave Symposium Digest,
  1980, pp. 407–409, DOI: `10.1109/MWSYM.1980.1124303`.
- Keysight Technologies, “RF Design Software Learning Kit,” application note
  5992-2079, for an independent commercial-tool description of the
  Hammerstad/Jensen model family.
- AMD/Xilinx, “Signal Integrity,” July 2005, for the first-order cylindrical
  via-inductance screening equation and its limitations in PCB use.

Run `python3 scripts/pcb_calc_tests.py` after changing calculator formulas or
input validation. Golden vectors protect implementation stability; they do not
establish field-solver accuracy.
