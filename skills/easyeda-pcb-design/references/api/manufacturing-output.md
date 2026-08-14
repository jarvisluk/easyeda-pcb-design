# API manufacturing output and regression

## Boundaries

Generate manufacturing files only after schematic/PCB checks and netlist
evidence are current, and only when the user has requested manufacturing
outputs. Exporting files is not ordering. Never call
`PCB_ManufactureData.placePcbOrder()`, `placeSmtComponentsOrder()`,
`placeComponentsOrder()`, or `place3DShellOrder()` unless the human separately
authorizes that external action; this skill's normal lifecycle stops before
those calls.

## API export sequence

1. Open the exact PCB UUID and read it back as document type PCB.
2. Create a new revision-specific host output directory; refuse existing file
   targets and do not use force.
3. Read the exact companion documentation, then call:
   - `getGerberFile()` for Gerber, outline, plated/non-plated drill and any
     included test data;
   - `getBomFile(..., "csv")`;
   - `getPickAndPlaceFile(..., "csv")`;
   - optional metadata exports only as diagnostics.
4. Save each returned `File` with
   `SYS_FileSystem.saveFileToFileSystem(path, file, undefined, false)`.
5. Verify each host file exists, is non-empty, has the expected MIME/file
   signature, and record SHA-256.
6. Run `scripts/audits/easyeda_manufacturing_audit.py` and retain its JSON.
7. Only after all API design and manufacturing operations are complete, do the
   final read-only Gerber/2D/3D visual regression allowed by the task.

## Required machine checks

The manufacturing audit requires a valid ZIP CRC; top/bottom copper, solder
mask and top paste; top silkscreen; board outline; the expected number of inner
copper layers; plated and non-plated drill files; terminated Excellon data; a
closed nonzero outline; BOM quantities/designators; and finite PnP coordinates,
side and rotation. Explicitly list expected designators and any allowed DNP or
manual-fit BOM omissions.

Machine checks do not prove connector mating view, polarity, paste adequacy,
assembly rotations, enclosure fit, panelization, impedance, stock, or
substitution acceptability. Those remain final visual/human release gates.

## Known beta behavior

EasyEDA Pro 3.2.166 live regression observed:

- `getPcbInfoFile()` returned `text/plain` and reported `0mil x 0mil` while the
  same export's closed Gerber outline measured nonzero dimensions;
- `getIpcD356AFile()` threw while destructuring a null internal result;
- BOM/PnP files named CSV were UTF-16 tab-delimited text.

Preserve these contradictions or failures in evidence. Use Gerber/drill as the
manufacturing geometry authority, parse the actual encoding, and do not
mislabel an optional beta diagnostic as a required release artifact.
