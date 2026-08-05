# EasyEDA API map for high-speed audit

## Contents

- Required API classes
- Units
- Copper validation
- Audit limitations

## Required API classes

Read the matching `easyeda-api` reference before use:

- `DMT_Project` — current project state;
- `DMT_SelectControl` — active document state;
- `PCB_Net` — complete PCB net-name list, including unrouted nets;
- `PCB_Layer` — layer names, types, and active layer;
- `PCB_PrimitiveComponent` — placement state included in the design fingerprint;
- `PCB_PrimitiveLine` — routed segments and lengths;
- `PCB_PrimitiveArc` — arc endpoints, angle, width, layer, and net;
- `PCB_PrimitivePolyline` and `IPCB_Polygon` — discretized polyline paths;
- `PCB_PrimitiveVia` — signal and GND vias;
- `PCB_PrimitivePour` — pour boundaries and island setting;
- `IPCB_PrimitivePour` — `getCopperRegion()` and `rebuildCopperRegion()`;
- `IPCB_PrimitivePoured` — generated fill records;
- `PCB_Drc` — final design-rule check;
- `PCB_Document` — save and board view.

## Units

EasyEDA PCB primitive coordinates use mils. Convert only at reporting boundaries:

- `mm = mil × 0.0254`
- `mil = mm / 0.0254`

Polygon Y orientation must be verified from the generated fill geometry. Never infer a valid copper area solely from the displayed boundary properties.

## Copper validation

For every pour:

1. call `getCopperRegion()`;
2. require a non-undefined result;
3. call `getState_PourFills()`;
4. require at least one `fill === true` record;
5. inspect `getState_PreserveSilos()`;
6. run DRC after rebuilding.

Do not equate `Boolean(rebuildCopperRegion())` with success until the associated filled-copper state is read back.

## Audit limitations

The bundled bridge audit intentionally does not claim to prove:

- arc and Bézier trace length;
- continuous reference-plane coverage beneath every segment;
- exact copper-void intersection;
- blind/buried-via start and end layers from the current via API;
- connector/BGA launch impedance;
- S-parameters or eye-mask compliance;
- field coupling or glass-weave effects.

The baseline and high-speed collectors must normalize the same project UUID,
document UUID, layers, complete net list, component placement, routed geometry,
vias, and copper state. A cleared high-speed report is valid only when its
design fingerprint matches the active PCB and it covers every detected
high-speed candidate. Missing legacy fingerprints are treated as stale.

Escalate those items to manual geometry review or an external solver.

Before executing a live audit, query `/eda-windows`. Require `--window-id` when
more than one window is connected; never silently audit whichever window was
last active.

The current bridge execution sandbox passes `eda` but does not expose global
enum objects. Collector generation may interpolate a value only after reading
the exact bundled enum reference; it must never guess a numeric enum value.
