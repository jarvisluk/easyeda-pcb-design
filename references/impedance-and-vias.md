# Analytical impedance and via estimates

## Contents

- Confidence and inputs
- Microstrip
- Differential microstrip
- Delay
- Via estimates
- Escalation limits

## Confidence and inputs

The bundled calculator provides first-order closed-form estimates. Required inputs:

- dielectric constant at a relevant frequency;
- finished dielectric height from trace to reference plane;
- finished trace width and copper thickness;
- edge-to-edge pair spacing;
- finished via drill, board thickness, and unused stub length.

Soldermask, copper roughness, trapezoidal etch, resin content, local glass weave, plated thickness, and frequency dispersion can shift results. Use the fabricator's field-solver output for production impedance coupons.

Reject nonphysical dimensions. Keep copper thickness below the trace-to-plane
distance for microstrip and below the nearest-plane distance for symmetric
stripline. Treat geometries near a model-domain boundary as solver-required.

## Microstrip

The calculator uses a conventional quasi-static closed-form microstrip approximation with a finite-thickness width correction. It reports:

- effective dielectric constant;
- estimated characteristic impedance;
- propagation delay in ps/mm.

The approximation is useful for initial geometry and cross-checking, not final production sign-off.

The microstrip implementation follows the quasi-static Hammerstad/Jensen model
family with a finite-thickness width correction. It does not implement the
frequency-dispersion, conductor-loss, or dielectric-loss extensions.

## Differential microstrip

The differential estimate applies an empirical edge-coupling correction to twice the single-ended impedance. It assumes:

- identical traces;
- constant edge-to-edge spacing;
- one continuous reference plane;
- no nearby aggressor copper or plane void;
- uniform cross-section.

Breakouts, bends, vias, connector launches, and reference changes require separate review.

## Delay

Propagation delay is estimated from effective dielectric constant:

`delay ≈ sqrt(effective_Dk) / c`

Use the same delay model for both pair members. Length matching cannot repair a large impedance or return-path discontinuity.

## Via estimates

The calculator reports:

- a first-order barrel inductance estimate;
- quarter-wave stub resonance estimate;
- wavelength in the dielectric at the specified frequency;
- return-via spacing as a fraction of wavelength.

Interpret these as screening values. Pad, antipad, plane sequence, backdrilling, connector launch, and return-via geometry dominate real via S-parameters.

Select the via screening frequency from the recorded edge spectrum or formal
compliance bandwidth. Do not choose a convenient frequency merely to obtain a
preferred return-via rating.

## Escalation limits

Require a field/S-parameter solver when any applies:

- multi-gigabit serial link;
- dense differential via transition;
- backdrilling or blind/buried microvias;
- large connector or BGA launch discontinuity;
- nonuniform or asymmetric cross-section;
- broadside coupling;
- coplanar waveguide with complex ground geometry;
- insertion loss, return loss, crosstalk, or eye-mask compliance is required;
- analytical result is near the tolerance boundary.
