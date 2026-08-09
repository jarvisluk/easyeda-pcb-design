# Switching-power layout

## Contents

- Scope and authority
- Build the power-stage constraint record
- Identify switching paths
- Place by current path
- Route power and sensitive nodes
- Ground, thermal, and magnetic decisions
- Verification and evidence

## Scope and authority

Use this reference for buck, boost, buck-boost, flyback, gate-driver, motor-drive,
and other switching-power stages. Start from the exact controller or module
datasheet, package drawing, evaluation-board layout, and topology. A generic
power rule must not override a device-specific current path, exposed-pad
connection, compensation layout, or thermal recommendation.

Do not treat `PGND`, `AGND`, `SGND`, or exposed-pad names as automatic plane
instructions. Determine which currents use each pin, when they flow, and where
the selected device requires them to join.

## Build the power-stage constraint record

Before placement, create one record per converter stage with:

- topology, operating modes, input/output voltage, peak/RMS current, switching
  frequency range, duty-cycle range, and thermal limits;
- controller/module, external switches, rectifier, input/output capacitors,
  inductor or transformer, shunt, compensation, and protection parts;
- every high-`di/dt` commutation loop for each switching state;
- every high-`dv/dt` node, including switch, phase, gate, and bootstrap nodes;
- gate-drive and bootstrap charge/discharge loops;
- feedback, remote-sense, current-sense, compensation, soft-start, and frequency
  programming paths;
- power/ground join policy and its device-source citation;
- copper weight, via technology, allowable loss/temperature rise, airflow,
  heatsink/enclosure, and assembly constraints;
- a thermal acceptance gate with sourced maximum component/junction
  temperature, allowed rise or thermal-resistance target, load/current,
  ambient, airflow, enclosure, duty cycle, and required analysis/measurement;
- an electrical/EMI acceptance gate for every high-`dv/dt` region with its
  device/reference-layout geometry limit plus ringing, near-field, conducted,
  and radiated evidence required by the product claim;
- required oscilloscope, efficiency, thermal, near-field, or emissions evidence.

Record a source and revision for every quantitative limit. Unknown loop,
clearance, copper, or thermal requirements remain unresolved.

## Identify switching paths

Draw the actual current path for every switch state. Compare the states and
mark the conductors whose current changes abruptly; the difference between
states identifies a commutation loop more reliably than visual inspection of
the schematic.

Classify at least:

1. the highest-`di/dt` input or rectification loop;
2. the output-current loop and its ripple component;
3. each gate-driver and bootstrap loop;
4. each high-`dv/dt` copper region;
5. feedback, compensation, current-sense, and reference paths vulnerable to
   capacitive, inductive, or common-impedance coupling.

For coupled inductors, transformers, multiphase stages, or four-switch
converters, identify every phase and operating mode separately. Do not assume a
single generic hot loop covers them all.

## Place by current path

1. Fix mechanically constrained connectors, isolation boundaries, and thermal
   interfaces.
2. Place the switching devices and the capacitor that closes the primary
   commutation loop. Minimize the complete forward-and-return loop, not only the
   visible forward trace.
3. Place gate resistors, driver bypass, and bootstrap parts at the pins they
   serve.
4. Place the inductor/transformer and output capacitor to keep the secondary
   current path direct while preserving thermal and magnetic clearance.
5. Place current-sense and feedback dividers at the sensed point. Route Kelvin
   pairs before ordinary control signals.
6. Place compensation and reference parts inside the controller's quiet region.
7. Reserve probe access that does not require a long measurement ground lead.

The smallest geometric layout is not automatically best. Check heat spreading,
component ratings, manufacturability, creepage/clearance, magnetic coupling,
repair access, and the selected device's reference layout.

## Route power and sensitive nodes

- Keep commutation-loop copper compact, wide enough for current and heat, and
  free of avoidable vias. When a layer transition is necessary, use an
  assembly-approved via array and keep opposite current directions closely
  coupled.
- Minimize high-`dv/dt` copper area subject to current and thermal requirements.
  Do not expand a switch node as decorative copper or route sensitive signals
  above, below, or beside it without device-specific evidence.
- Keep gate-drive forward and return conductors coupled. Do not share their
  return impedance with feedback or current-sense paths.
- Route differential or Kelvin sensing from the actual sense points. Avoid
  sampling after a noisy shared copper neck or via field.
- Keep feedback, compensation, clock, analog reference, reset, and antenna
  paths away from switch nodes, inductors, transformers, and commutation loops.
- Avoid test points that create a high-frequency stub or enlarge a switch node.

## Ground, thermal, and magnetic decisions

Prefer a continuous low-impedance reference plane unless the selected device
requires a documented partition. Control current paths by placement and copper
geometry before cutting a ground plane. Any intentional join must name the
currents kept apart and the exact join location.

Use thermal analysis and the package data to size exposed-pad copper, thermal
vias, planes, airflow, and heatsinks. A large copper area can conflict with a
high-`dv/dt`-node limit. Evaluate candidate geometry through two independent
acceptance gates:

1. the thermal gate must meet the recorded current/load, maximum junction or
   component temperature, allowed temperature rise or thermal-resistance
   target, and environmental conditions;
2. the electrical/EMI gate must preserve the device-sourced switch-node and
   commutation geometry and meet the required ringing, near-field, conducted,
   and radiated evidence for the intended claim.

The candidate closes only when both gates close on the same revision and
operating condition. Documenting a compromise is not acceptance. If no copper
geometry passes both, revise package, cooling, switching frequency, topology,
board area, placement, or another governing requirement and rerun the joint
floorplan/stackup gate.

Follow the inductor or transformer vendor's keepout and shielding guidance.
Do not impose a universal rule to always retain or always remove copper under a
magnetic component. Review saturation, fringing field, eddy-current loss,
shielding, temperature, and nearby sensitive circuits.

## Verification and evidence

Before closure:

1. annotate the PCB with every recorded loop and sensitive path;
2. measure or calculate path length, copper necks, via count, and current area;
3. verify generated copper fill and plane continuity rather than pour outlines;
4. run DRC and inspect the exact saved/reopened revision;
5. check startup, steady-state, load transient, switch-node/gate ringing,
   efficiency, current limit, and worst-case temperature as applicable;
6. collect near-field, conducted, or radiated evidence when an EMC claim is
   required.

Report the thermal and electrical/EMI gate results separately. Either gate
`BLOCKED`, `UNRESOLVED`, or `STALE` keeps the power-stage constraint conflict
open and prevents aggregate placement or release closure at the affected
scope.

Checklist review cannot prove stability, thermal margin, or emissions. Bind
measurement and simulation artifacts to the exact schematic, PCB, BOM,
firmware/mode, load, probe method, and environmental condition.
