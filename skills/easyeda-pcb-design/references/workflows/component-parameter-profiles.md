# Component parameter profiles

## Contents

- Purpose
- Complete the parameter-coverage contract
- Decide what counts as consequential
- Integrated circuits and modules
- Passives and timing parts
- Semiconductors and protection
- Electromechanical and safety parts
- Close derived or condition-dependent parameters

## Purpose

Load this reference whenever selecting, changing, or reviewing a PCB-included
part. Use it with
[component-selection-evidence.md](component-selection-evidence.md). The
selection-evidence workflow owns source preservation, schema, library binding,
and audit execution; this reference owns parameter coverage by component class.

The lists below are screening profiles, not fixed datasheet field lists. Record
every listed item that can affect the actual design and add any device-specific
parameter that changes function, margins, layout, firmware, mechanics,
assembly, reliability, safety, or procurement identity.

## Complete the parameter-coverage contract

Every PCB-included evidence entry must classify these aspects exactly once in
`parameterCoverage`:

- `FUNCTIONAL_CAPABILITY`
- `ELECTRICAL_LIMITS`
- `OPERATING_RANGE`
- `TOLERANCE_ACCURACY`
- `POWER_THERMAL`
- `TIMING_FREQUENCY`
- `SIGNAL_INTEGRITY_PARASITICS`
- `MECHANICAL_ASSEMBLY`
- `ENVIRONMENT_RELIABILITY`

Use one status for each aspect:

- `AUDITED` — sourced numeric parameters are linked to deterministic
  `suitabilityChecks` against board requirements;
- `RECORDED` — sourced numeric parameters are retained for traceability, but no
  board-side acceptance comparison is required for this revision;
- `NOT_APPLICABLE` — the aspect genuinely does not apply, with a concrete
  rationale. Do not use this state because a datasheet field was hard to find.

Every sourced parameter must appear in at least one coverage aspect. Every
check must appear both in an `AUDITED` aspect and in the part's
`suitability.checkIds`. Every populated or manual-fit part needs at least one
`AUDITED` aspect, including a standard passive's value/rating acceptance check;
every consequential parameter needs an audited comparison or an explicit
unresolved blocker.

## Decide what counts as consequential

A parameter is consequential when changing it within plausible candidate-part
values could alter any of the following:

- whether the circuit works across supply, load, temperature, tolerance, and
  startup/transient conditions;
- pin mapping, voltage compatibility, firmware behavior, calibration, timing,
  bandwidth, noise, accuracy, RF behavior, or EMC;
- dissipation, junction temperature, pulse stress, derating, lifetime, or
  safety margin;
- land pattern, body height, orientation, mating, access, assembly process, or
  service life;
- an exact ordered variant, qualification grade, or regulatory claim.

Record minimum/typical/maximum semantics and the governing conditions. Do not
collapse condition-dependent values into a single optimistic number. For
example, record MOSFET RDS(on) at the actual gate voltage, capacitor effective
capacitance after DC bias, and optocoupler CTR at the intended LED current and
temperature.

Keep numeric limits in `parameters`. Keep consequential categorical properties
such as dielectric class, antenna variant, qualification grade, polarity, or
mating family in the sourced `requirements` list, and mention them in the
relevant coverage rationale. Do not discard a selection-critical property merely
because it is not numeric.

## Integrated circuits and modules

### MCU, processor, FPGA, radio, and integrated module

Consider:

- exact memory/capability variant, supported interfaces, channel/pin count, RF
  band, onboard/external antenna variant, and required boot/programming mode;
- recommended and absolute supply ranges, I/O thresholds and tolerances,
  domain sequencing, current by operating mode, inrush or radio peak current;
- clock range/accuracy, startup timing, reset/boot thresholds, watchdog or
  brownout behavior, internal pull strengths, and external component limits;
- package, pitch, exposed pad, moisture sensitivity, operating temperature,
  qualification grade, and module keepout/certification constraints.

Audit capability and voltage-range containment. Audit current peaks against the
rail budget and record clock, RF, thermal, and package constraints used by the
schematic and PCB.

### Sensor, op-amp, comparator, ADC, DAC, reference, and analog front end

Consider:

- measurement/input/output range, common-mode range, rail headroom, source/load
  drive, input impedance, bias/leakage, offset, gain error, linearity, drift;
- noise density/integrated noise, bandwidth, slew/settling time, sample rate,
  aperture/jitter limits, reference requirements, CMRR/PSRR, and stability load;
- supply/current range, channel isolation/crosstalk, input protection limits,
  calibration needs, package parasitics, thermal gradient sensitivity, and
  temperature grade.

Audit the actual signal range, accuracy/noise budget, bandwidth/settling, source
impedance, load stability, and reference error allocation rather than quoting a
headline resolution or bandwidth.

### Linear and switching regulators, supervisors, chargers, and power modules

Consider:

- input/output ranges, continuous and peak current, dropout or duty-cycle
  limits, efficiency, quiescent/shutdown current, current limit, startup/inrush;
- output accuracy, line/load regulation, transient response, ripple/noise,
  switching frequency, compensation/stability, required capacitor value/ESR;
- dissipation, thermal resistance, junction limit, derating, protection modes,
  sequencing, enable thresholds, package and exposed-pad requirements.

Use the mandatory linear-regulator thermal audit where applicable. Switching
parts need a preserved loss/thermal calculation and validation of inductor,
diode/MOSFET, capacitor, compensation, and layout requirements.

## Passives and timing parts

### Resistor, shunt, thermistor, and resistor network

Consider resistance, tolerance, temperature coefficient, ratio tracking,
noise, rated power at ambient, derating curve, maximum working/overload voltage,
pulse or surge energy, current-sense Kelvin requirements, thermal resistance,
package, and temperature range. Audit worst-case value and power/voltage/pulse
stress. A nominal resistance alone is not sufficient.

### Capacitor

Consider nominal capacitance, tolerance, rated voltage, dielectric/class,
DC-bias and temperature coefficients, aging, effective minimum capacitance,
ESR/ESL, ripple current, dissipation factor, leakage, polarity, surge behavior,
package, height, and temperature/lifetime rating. Audit effective capacitance
under actual bias and temperature, voltage derating, ripple/ESR heating, and any
regulator stability window.

### Inductor, ferrite bead, and transformer

Consider inductance or impedance with test frequency, tolerance, DCR, RMS rated
current, saturation current and its criterion, core loss, self-resonant
frequency, impedance curve, insulation/isolation, turns ratio, leakage and
magnetizing inductance, package, thermal rise, and temperature range. Audit
peak/RMS current, saturation margin, copper/core loss, and impedance at the
actual noise or switching frequency.

### Crystal, resonator, and oscillator

Consider nominal frequency, initial tolerance, temperature stability, aging,
total frequency error, load capacitance, ESR, motional parameters, drive level,
startup margin, oscillator supply/current, phase noise or jitter, duty cycle,
startup time, package, and temperature grade. Audit the frequency/jitter budget,
effective load capacitance, negative-resistance/startup margin when required,
and maximum drive level. Route physical constraints through the crystal audit.

## Semiconductors and protection

### MOSFET, BJT, gate driver, and load switch

Consider voltage/current limits, gate/base thresholds and absolute limits,
RDS(on) at actual gate voltage and temperature, gain, leakage, switching charge,
capacitances, switching time, SOA, avalanche or pulse energy, body diode,
current limit, dissipation, thermal impedance, package and exposed-pad details.
Audit static and switching loss, junction temperature, gate-drive compatibility,
SOA/pulse stress, and transient limits.

### Rectifier, signal diode, TVS, ESD array, and varistor

Consider working/repetitive reverse voltage, breakdown and clamp voltage at the
specified current, forward current and surge current, forward drop, leakage,
capacitance, dynamic resistance, pulse waveform/energy, power derating,
temperature and package. Audit normal operating voltage, surge waveform and
source impedance, protected-device clamp limit, current path, and interface
capacitance/bandwidth.

### LED, laser, optocoupler, and isolator

Consider forward voltage range, recommended/absolute current, optical output,
wavelength/color bin, luminous intensity, CTR or transfer gain and aging,
isolation working/withstand voltage, creepage/clearance, propagation delay,
CMTI, input/output thresholds, dissipation, temperature, and package. Audit
current-setting tolerance, resistor/device power, optical/CTR margin, timing,
and isolation requirements.

## Electromechanical and safety parts

### Connector, socket, switch, relay, fuse, and protection element

Consider contact/pole count and exact mating view, pitch/keying, current and
voltage per contact, contact resistance, insertion cycles, insertion/withdrawal
force, isolation, creepage/clearance, coil voltage/current, contact load and
life, fuse hold/trip current, interrupt rating and I2t, resettable-fuse
temperature derating, body height, mounting retention, plating, temperature,
flammability and qualification grade.

Audit current/voltage and temperature derating, contact or switching load,
fault interruption energy, exact mate compatibility, mechanical envelope, and
safety spacing. A footprint match alone does not prove connector compatibility.

## Close derived or condition-dependent parameters

Preserve the manufacturer inputs separately before calculating an effective or
worst-case value. Bind every calculation to its input parameter IDs, board
requirement IDs, formula/tool version, conditions, and result artifact. Examples
include capacitor effective capacitance, resistor pulse power, MOSFET loss,
inductor saturation/loss, crystal load capacitance, ADC error/noise budget, and
connector temperature derating.

When the generic range/minimum/maximum checks are sufficient, use them. When a
specialized deterministic checker exists, use it. Otherwise preserve the
calculation as revision-bound evidence and keep the affected aspect unresolved
until a qualified review closes it. Never turn a missing model into
`RECORDED` or `NOT_APPLICABLE` merely to pass the handoff.
