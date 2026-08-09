# Mixed-signal ADC and DAC layout

## Contents

- Scope and precedence
- Partition by current path
- Ground and power strategy
- Clock, reference, and analog path
- Converter interface and placement
- Verification

## Scope and precedence

Use this reference for ADCs, DACs, codecs, sensor front ends, precision
references, instrumentation amplifiers, and mixed-signal MCUs. The exact
converter datasheet, evaluation-board documentation, driver/reference data,
and product accuracy/noise requirements take precedence over generic advice.

Do not infer the board ground topology from pin names alone. `AGND` and `DGND`
identify device domains; they do not universally require a split plane or a
single-point join.

## Partition by current path

Before placement, record:

- signal amplitude, source impedance, bandwidth, sample/update rate, required
  ENOB/SNR/THD/noise, and allowed error budget;
- analog-input or output-driver topology, anti-alias/reconstruction filter,
  reference source/buffer, clock source/driver, digital interface, and loads;
- analog, reference, clock, digital-I/O, core-supply, and external-cable
  forward/return paths;
- high-level, low-level, high-impedance, switching, and high-`di/dt` nodes;
- isolation, shield, chassis, connector, and cable-return boundaries;
- required simulation, FFT/noise, time-domain, or laboratory evidence.

Partition the board so noisy digital, switching-power, and cable currents do
not cross the quiet analog/reference region. Keep the converter at the boundary
between its analog chain and digital destination when that placement preserves
both paths.

## Ground and power strategy

Choose between a continuous ground plane and intentionally partitioned planes
from the actual return-current map:

1. Prefer a continuous reference when placement can keep noisy and sensitive
   currents in separate regions without shared narrow impedance.
2. Partition only when the device/system source and current-path analysis
   justify it. Name the currents isolated, the join component/location, and
   every signal crossing the boundary.
3. Never route a referenced signal across a split without a deliberate nearby
   return transition.
4. Prevent digital, clock, regulator, or cable return current from sharing the
   analog input, reference, or converter-ground connection.
5. Treat chassis, shield, analog, digital, and isolated grounds as separate
   functional boundaries until their coupling/join strategy is defined.

Record each rail's noise allowance, transient load, target impedance, filter or
regulator, decoupling loop, and device-specific sequencing. Do not insert a
ferrite bead by habit: verify DC drop, saturation, impedance spectrum, resonance,
and regulator/load interaction.

## Clock, reference, and analog path

- Place the input driver, filter, converter input, and return as one local
  signal chain. Keep high-impedance nodes short and away from fast-edge copper.
- Route differential analog paths symmetrically where the circuit depends on
  matched parasitics, but do not add length solely for visual symmetry.
- Place the voltage reference and its buffer/filter/decoupling according to the
  converter source. Keep reference-load transients out of input and ground paths.
- Treat the sample clock as both a sensitive analog-quality signal and a noise
  aggressor. Control its return, source termination, fanout, and power noise.
- Do not share a clock-driver package or supply domain across incompatible
  clocks without jitter/crosstalk evidence.
- For very high-impedance amplifier inputs, decide any plane void from the
  amplifier/vendor stability guidance and a capacitance/noise analysis; do not
  remove reference copper generically.

## Converter interface and placement

Place local decoupling by the pin and mounted-loop inductance, not by a universal
capacitance order. Use separate vias where they materially reduce shared
inductance and follow the selected package/reference layout.

Verify exposed-pad net, thermal function, paste segmentation, via filling or
tenting, and assembly process from the package documentation. Never assume an
exposed pad is ground.

For SPI, LVDS, JESD, CMOS, or parallel converter data:

- classify from actual edge rate, loading, topology, and route length;
- keep the digital interface inside its region and away from input/reference
  paths;
- apply the matching high-speed protocol guidance when controlled impedance,
  timing, loss, or launch constraints apply;
- slow programmable output edges when the silicon source permits and timing
  remains satisfied.

## Verification

Review the exact revision for:

- uninterrupted analog, digital, reference, clock, and cable return paths;
- no shared copper neck or via that couples a noisy current into a sensitive
  reference;
- correct converter, driver, reference, decoupling, exposed-pad, and connector
  placement against the current vendor sources;
- rail noise, reference settling, clock jitter, input settling, and digital
  timing assumptions;
- DRC, copper fill, assembly, thermal, and enclosure effects.

When performance matters, measure the intended metrics with the final clock,
firmware mode, input source, load, enclosure, and power configuration. An
evaluation-board result or clean DRC is not evidence for the product PCB.
