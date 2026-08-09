# Protocol starting profiles

## Contents

- Use rules
- Common profiles
- Interface-specific review
- Timing and bandwidth

## Use rules

These values are planning defaults, not substitutes for the current interface specification, silicon datasheet, reference design, connector model, cable, or fabricator coupon.

Always record the source used for the final target.

## Common profiles

| Interface | Typical differential target | Primary concerns |
|---|---:|---|
| USB 2.0 High Speed | 90 ohm | pair continuity, short stubs, connector/ESD launch |
| USB 3.x | 90 ohm | insertion/return loss, via launch, pair skew, connector model |
| Ethernet twisted-pair PHY routing | 100 ohm | magnetics placement, pair symmetry, isolation |
| LVDS | 100 ohm | termination, skew, continuous reference |
| HDMI TMDS | 100 ohm | pair skew, inter-pair skew, connector launch |
| PCIe | commonly 85 ohm | loss budget, return loss, via stubs, reference changes |
| DisplayPort | commonly 100 ohm | lane skew, connector/ESD discontinuities |

For CAN, RS-485, DDR, MIPI, SDIO, QSPI, and proprietary ADC/DAC interfaces, use the transceiver or silicon vendor's layout and impedance requirements. Do not assign a target from this table.

## Interface-specific review

Load only the matching subsection, then obtain the current specification,
silicon datasheet, reference design, and package/connector models.

### USB 2.0 Full/High Speed

- Record the transceiver pins, connector pins, ESD/protection parts, test
  points, target impedance, allowed skew, and maximum stub length.
- Review the connector-to-protection-to-transceiver path as one channel.
- Fix the connector mechanically, place ESD at the connector, and place series
  resistors/termination where the silicon vendor requires—commonly near the
  transceiver—then place the transceiver or module so the remaining channel is
  direct and short. Do not trade away the connector-side ESD path merely to
  minimize chip-to-connector distance.
- Record a maximum routed length only from the silicon/interface source or as a
  labeled project target. There is no universal module-to-USB-connector spacing
  that applies to Full Speed, High Speed, and SuperSpeed alike.
- Treat controlled impedance as necessary but insufficient: also close return
  continuity, pair coupling/skew, stubs, vias, protection capacitance,
  connector launch, and the applicable loss/reflection budget.
- Check protection capacitance and common-mode choke placement against the
  selected silicon reference design.

### USB 3.x

- Record generation, lane mapping/polarity, AC-coupling ownership, channel loss
  budget, return-loss target, compliance bandwidth, and connector/cable model.
- Review every via, residual stub, reference change, protection component, and
  connector launch with S-parameter or field-solver evidence.

### Ethernet PHY to magnetics

- Record PHY, magnetics, termination/bias topology, isolation boundary, pair
  mapping, center taps, chassis/shield strategy, and reference-design limits.
- Review pair symmetry, common-mode conversion, and the connector-side ESD
  current path separately from PHY-side routing.

### LVDS

- Record driver/receiver family, point-to-point or multidrop topology,
  termination ownership/value, common-mode range, target impedance, and skew
  budget.
- Check package delay and connector/cable delay before assigning PCB length
  compensation.

### HDMI TMDS

- Record HDMI version, lane mapping, intra-pair and inter-pair skew budgets,
  connector/protection model, DDC/CEC/HPD requirements, and compliance
  bandwidth.
- Review the complete launch and common-mode conversion, not only pair length.

### PCI Express

- Record generation, lane count, bifurcation/lane reversal, AC-coupling
  ownership, package loss allocation, board loss allocation, connector model,
  return-loss target, and compliance bandwidth.
- Treat every connector, BGA escape, layer transition, and residual via stub as
  a modeled channel discontinuity.

### DisplayPort

- Record link rate, lane count, lane mapping/polarity, AC-coupling ownership,
  AUX/HPD routing, connector/protection model, and channel loss/skew budgets.
- Review main-link and AUX requirements independently.

### DDR and parallel source-synchronous buses

- Use the exact memory generation, controller, package, topology, ODT,
  termination, setup/hold, flight-time, and write/read leveling requirements.
- Separate byte-lane, DQS-to-DQ, address/command/control, clock, and package
  delay budgets. Do not use one universal length-matching limit.

### MIPI, SDIO, QSPI, CAN, RS-485, and proprietary links

- Obtain impedance, topology, termination, edge rate, timing, loading, stub,
  ESD, and connector limits from the chosen devices and current interface
  specification.
- Classify from actual edge rate and channel structure; a low clock number does
  not automatically make the route baseline.

## Timing and bandwidth

Use edge rate, not only clock frequency, to decide whether a net behaves as a transmission line. If rise/fall time is unknown, obtain it from the IBIS model or datasheet.

For solver planning:

- include at least the Nyquist frequency for data-dependent effects;
- extend higher for via/stub resonance screening;
- use the vendor compliance bandwidth for formal validation.

Length-skew limits are implementation- and protocol-specific. Store the chosen limit in the project constraint record rather than embedding a universal value.
