# PDN, ESD, and EMC review

## Contents

- PDN constraints
- Connector and ESD current paths
- Common-mode and emissions review
- Evidence gates

## PDN constraints

Record rail voltage, maximum transient current, allowed ripple, target
impedance, frequency range, package/on-die assumptions, plane geometry, and
regulator control bandwidth.

1. Derive target impedance from the recorded transient current and allowed
   ripple; do not assign a universal value.
2. Review capacitor mounting inductance, package inductance, plane spreading
   inductance, effective capacitance under bias, ESR, tolerance, and aging.
3. Check anti-resonance between capacitor families and between the board and
   package models.
4. Review BGA escape and power/ground via fields for simultaneous-switching
   noise and current density.
5. Separate switching-current loops from clock, reference, ADC/DAC, RF, and
   other sensitive return paths.
6. Use an impedance simulation or measurement when the target must be proven.

Do not treat capacitor count or nominal capacitance as evidence that a rail
meets its target impedance.

## Connector and ESD current paths

1. Trace the ESD/surge current from the connector contact through protection
   and into chassis or board reference.
2. Put the protection device at the entry point and minimize the protected-node
   stub.
3. Include protection capacitance, package, pad, antipad, and return-via
   parasitics in high-speed launch review.
4. Define chassis-ground, shield, signal-ground, and isolation boundaries.
5. Keep discharge current out of digital, analog, clock, antenna, and
   regulator-feedback return paths.

## Common-mode and emissions review

1. Review pair asymmetry, uncoupled length, skew, dissimilar vias, connector
   launches, and reference discontinuities for differential-to-common-mode
   conversion.
2. Review board-edge proximity, cable launches, slots, long return detours, and
   floating copper as possible antennas.
3. Use stitching vias or shield connections where they complete a deliberate
   current path; do not add decorative via fences.
4. Confirm common-mode choke placement and parasitics from the interface
   specification and reference design.
5. Define the pre-compliance scan, chamber test, current-probe, near-field, or
   conducted-emissions evidence required by the product.

## Evidence gates

Record each applicable result as `MANUAL_REVIEWED`, `SOLVER_VERIFIED`, or
`MEASUREMENT_VERIFIED` with the artifact and exact PCB revision. Return
`UNVERIFIED FOR FABRICATION` when a required PDN, ESD, or EMC claim lacks its
specified evidence.
