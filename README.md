# Flightboard Studio

Desktop editor (Electron + Vue 3 + TypeScript) that turns public airport data into an LED wall-board design:
search an airport, build the art layers from OpenStreetMap and (for US airports) the FAA's airport-mapping
polygons, auto-place LEDs with the same rules as the O'Hare board, adjust everything in a 2D editor, and export the
complete Altium project (through the .NET generator in `../pcbgen`) plus the board definition the firmware
(`../flightboard`) runs from.

```
pnpm install
pnpm dev            # run the app
pnpm typecheck      # vue-tsc + tsc
pnpm build:mac      # package (electron-builder; publishes ../pcbgen self-contained into the app first)
pnpm build:mac:local # same, ad-hoc signed (local use; build:mac:dir makes only the .app)
pnpm build:mac:x64   # Intel DMG, cross-built (ad-hoc signed)
pnpm build:win       # Windows installer (on Windows)
pnpm art             # regenerate the app icon and the DMG background (build/)
FB_AUTOTEST=KORD FB_AUTOTEST_DIR=/tmp/kord pnpm dev   # smoke test: build, edit ops, path tools, export, screenshots, quit
FB_AUTOTEST=KROA FB_AUTOTEST_PCB=1 FB_AUTOTEST_DIR=/tmp/kroa pnpm dev   # + PCB tab: blocks, checks, chains, Altium export
```

**Packaging.** `scripts/publish-pcbgen.sh [rid]` publishes the Altium generator self-contained (no .NET needed) to
`../pcbgen/out/publish/<rid>`; electron-builder copies it to `Contents/Resources/pcbgen` and the template's design
files to `Contents/Resources/pcbgen-template/Plane_Template` (`extraResources` in `electron-builder.yml`). A packaged
app uses only those two (or `FB_PCBGEN` / `FB_PCBGEN_TEMPLATE`), never a pcbgen checkout, so a built app exports
Altium projects on its own. The generator's .NET dylibs keep Microsoft's signature, hence
`com.apple.security.cs.disable-library-validation` in `build/entitlements.mac.plist`. `build:mac` signs with the first
identity electron-builder finds (on this Mac there are two identical "Apple Development" certificates, which codesign
rejects as ambiguous: set `CSC_NAME` or remove the duplicate); `build:mac:local` signs ad-hoc. The firmware install
still needs a flightboard checkout (`~/Projects/Koios/Matrx/flightboard`) and `python3`.
The app is "Flightboard Studio" (`net.koiosdigital.flightboard-studio`); its settings and download cache stay in
`~/Library/Application Support/flightboard-studio`. The DMG has its own window: the background (`build/background.tiff`,
1x + 2x, drawn by `scripts/make-art.mjs`) with the app and an Applications link side by side.
Packaged smoke test: `FB_AUTOTEST=KROA FB_AUTOTEST_PCB=1 FB_AUTOTEST_DIR=/tmp/kroa "dist/mac-arm64/Flightboard Studio.app/Contents/MacOS/Flightboard Studio"`.

**CI and releases** (`.github/workflows/build.yml`, set-up steps in `RELEASING.md`): every push builds macOS arm64,
macOS x64 and Windows x64; a `vX.Y.Z` tag also publishes a GitHub release. macOS builds are signed and notarized when
the Developer ID secrets are set, else ad-hoc signed.

Autotest and batch runs start their own window (electron-vite takes the next free port) and quit by themselves;
there is no need to close a studio that is already open.

## Flow

1. **Airport** tab: search the bundled OurAirports list (large/medium airports plus small ones with scheduled
   service), pick one, choose options, **Build board**.
   - OSM (Overpass, mirrors tried in order, responses cached under the app's user-data folder): aeroway
     features in a bounding box around the reference point, buildings inside the aerodrome area, landside roads /
     rail / parking inside the map frame in ~2.5 km tiles.
   - FAA AIS Airport Mapping (`AM_Taxiway`, `AM_Apron`, `AM_Runway`, `AM_Building`, `AM_Stopway`): surveyed
     pavement and building footprints, public domain. Used when the airport is covered; otherwise pavement is
     buffered from the OSM centrelines.
   - Aeroway features are first filtered to the airport itself: the OSM aerodrome polygon that contains the
     airport's reference point (else the runway cluster nearest it), so a private strip or heliport a few km
     away cannot stretch the frame. The map frame is the runways' bounding box plus a ground pad; the board is the largest "nice" scale that fits
     the maximum size, or whatever size you set later (everything rescales, LED bodies keep their mm size).
2. **LEDs** tab: placement settings and **Place LEDs** / **Regenerate labels**. Rules (from the ORD board):
   runway LEDs evenly along each runway axis rotated along it, one shared LED where two runways cross (it belongs to
   both runway features); one LED per OSM gate stand pushed off the terminal
   wall and merged below the minimum pitch; taxiway and apron-lane LEDs aligned to their centreline tangent, a
   centre LED at every junction plus one at the entry of each arm, even spacing between junctions, hold-short LEDs
   outside the runway pavement. Taxiways use the 1.5 mm part, apron lanes and gates the 1.0 mm part by default.
   A last pass (`core/spacing.ts`) merges any two LEDs whose pads would come under 0.15 mm apart (each LED as its
   rotated footprint square, 1.9 mm / 1.05 mm, the same envelope the generator checks): runway > taxiway > ramp > gate,
   then junction / entry / hold over plain, else the first placed; two gates become one LED for both stands. Hand-placed
   (locked) LEDs are never removed. The LEDs and PCB tabs list any pair still too close (hand edits) with *select*.
3. **Editor** (CAD-style):
   - Tools: `v` select, `a` node (direct select), `h` pan, `l` LED, `n` line, `p` polygon, `e` pen,
     `b` rectangle, `o` ellipse, `y` polygon / star, `t` label, `c` scissors, `k` knife, `r` rotate with the
     cursor, `m` measure. Wheel zooms; right-drag, middle button, ⌥-drag or the pan tool pans (a right-click
     without dragging opens the context menu).
   - Selection: click, shift-click to add/toggle, drag a box on empty space (shift adds), `⌘A` all LEDs and
     labels. The right panel edits one item or the whole multi-selection.
   - Move with snapping: object centres/vertices, points on centrelines and polygon edges, smart alignment
     guides (magenta lines), optional grid; hold ⌥ to move freely, ⇧ to constrain to an axis. Arrows nudge
     0.1 mm (⇧ 1 mm). The **Snap** menu holds the settings (kept between sessions).
   - Arrange (toolbar menu, right-click menu or inspector): align left / horizontal centres / right / top /
     vertical centres / bottom, distribute horizontally / vertically, match orientation of the first selected,
     orient to the nearest 90°, follow the nearest centreline, rotate 90°, `[` `]` rotate by the snap step,
     duplicate `⌘D`, lock / unlock, delete.
   - Lines and polygons: draw with clicks (double-click or Enter to finish, Esc cancels), or drag a rectangle
     (optional corner radius), ellipse or regular polygon / star (⇧ square / circle / upright, ⌥ from the
     centre). Polygons have a layer (silk / copper), a fill (outline, solid, hatch) and hatch settings (angle,
     pitch, line width, cross-hatch).
   - Path editing (Illustrator direct selection + Altium track editing), from the **Path** menu, the right-click
     menu or the inspector:
     - Node tool: click a vertex or a segment (⇧ adds), drag a box around vertices, drag to move them (with
       snapping), click a ◇ midpoint to add a node and drag it, `⌘A` selects every node of the path, arrows
       nudge the selected nodes, `Del` removes the selected segments, otherwise the selected nodes.
     - Node operations: delete nodes, remove segments (a line splits, a polygon opens), disconnect at nodes,
       add nodes at segment midpoints, straighten between nodes, align nodes on one X / one Y / collapse,
       fillet or chamfer corners. One selected node shows editable X/Y; one selected segment shows editable
       length and angle.
     - Pen: click to draw, click the first point to close; on a selected path click a segment to add a node,
       a node to remove it, a line end to continue the line.
     - Scissors cuts a path at the clicked point (a polygon opens into a line). Knife: drag a line across
       polygons and lines to slice them (the selection, else everything under the cut).
     - Path operations: join lines `⌘J` (closest ends, or the two selected end nodes; coincident ends merge,
       otherwise a bridging segment), close a line into a polygon, open a polygon into a line, reverse, outline
       stroke, offset / inset, simplify, smooth, split holes into polygons, remove holes.
     - Pathfinder on two or more polygons: unite, subtract (the first selected minus the others), intersect,
       exclude, divide (every overlap region becomes its own polygon).
     - Pieces keep the class, layer, width and source of the path they came from and are locked, so
       re-applying sources keeps the edit. Everything is undoable.
   - Runways tab: add blast-pad chevrons or displaced-threshold arrows at either runway end, and designator
     labels; all markings are editable runway-marking lines.
   - Runway end style (Runways tab, saved in the project; new boards stay *Classic*): *End chevrons* puts a
     double-line chevron past each runway end (apex outward or inward; stroke, gap, span × runway width, depth ×
     span, offset from the pavement end and the largest text are settings) with that end's designator inside it,
     number over side letter, reading from the approach (the side is found from the landing heading). It removes
     the designators on the runway and, as set, the stopway (EMAS / blast pad) outlines, also cut out of the
     pavement outline, and the "RUNWAY 09C – 27C" name labels. The text is fitted inside the inner stroke; depth
     shortens near the board edge. *Regenerate end markings* replaces them; *Regenerate labels* keeps them. The
     chevron lines are locked runway markings tagged `rwy-end` and the designators labels tagged `rwy-end`.
   - Labels: generated with collision resolution against LED bodies and each other (title > runway > designator
     > terminal > taxiway sign > road); **Labels ▸ Resolve label collisions** re-runs it after edits. Locked
     labels are never moved or dropped.
   - Undo/redo covers everything (`⌘Z` / `⇧⌘Z`). Hand-placed or edited LEDs are locked and survive re-placement.
4. **Sources** tab: the landside comes from a configurable list of OSM sources. Each source is an Overpass tag
   filter (e.g. `["highway"~"^(motorway|trunk)$"]`), a kind (line / polygon) and a drawing style: single line,
   two edges with lane dashes (width from the OSM `lanes` tag), edges plus centre line, dashed, dotted, line with
   ticks (rail) or outline; plus minimum length / area, tag drop-lists, a landside-only filter and cutting under
   airside pavement. Defaults reproduce the O'Hare board's look (motorways with lane dashes, primaries with a
   centre line, local roads single, rail with ticks, people mover dashed, subway dotted, garages and water
   outlined). **Apply** regenerates from the cached download, **Fetch & apply** re-queries with changed filters,
   sources can be added or removed, and the list can be saved as the default for new boards. The Overpass
   endpoint list is editable there too. Features you edited (locked) are kept when sources are re-applied.
5. **Export…** writes a folder with:
   - `board.json` – id, name, ICAO/IATA, elevation, size, corner radius, scale, mm-per-metre, projection, map
     frame and the metres→mm transform, board origin and corners in lat/lon.
   - `lights.json` – every LED: ref `Dn`, x/y mm from the top-left corner (y down), rotation (visual CCW from +x),
     size, class (runway / taxiway / ramp / gate), role (junction / entry / hold), feature, label, lat/lon.
   - `top_silk.svg`, `top_copper.svg`, `bottom_silk.svg` (the back silk, see below), `edge_cuts.svg` – sized to the board
     (`width`/`height` in mm, `viewBox 0 0 W H`), everything as filled paths (text converted to outlines with the
     bundled Jost font), silkscreen cut around LED bodies and around exposed copper.
   Save/Open keep the whole project as `<id>.flightboard.json`.
6. **PCB** tab: the Altium generator (`../pcbgen`, C# / AltiumSharp) runs as a sidecar process.
   - **Prepare** sends the board to the generator as a `pcbgen-job/1` job (`core/pcbjob.ts`: silk, back silk and
     copper art as polygons with the text outlined, LEDs with rotation / size / feature, block poses, options) and loads the
     template's blocks. The template is `../pcbgen/template/Plane_Template` unless you pick another folder.
   - **Blocks**: the MCU (antenna out over an edge), USB-C PD (any edge, its lowest point on the edge) and DCDC
     (anywhere within 40 mm of the USB-C block). **Auto-place** finds LED-free slots (USB-C prefers the bottom
     edge). Drag a block on the board: edge blocks slide along and jump between edges, the DCDC moves freely,
     `[` `]` rotate it, arrows nudge, `Del` returns a block to automatic placement. Every move is checked live
     (LEDs under the block, art it cuts, board outline, the DCDC distance); a failing block is drawn red with the
     reason in the panel and the inspector.
   - **Chains**: **Assign chains** splits the LEDs into the data channels (angular sectors around the MCU,
     balanced counts, nearest-neighbour + 2-opt order) and draws each chain on the board. Select LEDs to put them
     on a chain by hand, or keep their position in it (inspector); the generator balances the rest.
   - **Preview routing** runs the generator's placement and routing in memory (no files): data tracks are drawn on
     the board (top red, bottom blue), data vias yellow, 5SW vias purple, caps grey, unrouted hops as magenta dashes,
     with the hop / via / track totals in the panel. The chains view dims under a current preview; changing the board,
     a block or a chain marks the preview out of date. An export shows its own routing the same way.
   - **Live** (on by default): after a full preview the generator keeps that board in memory, and LED edits update
     it in place 150 ms after you stop: moved, rotated, resized, added or deleted LEDs and hand chain edits. The
     changed LEDs get their cap and 5SW via placed again, the obstacle map / corridors / exposed copper are redone
     around them, and only the touched hops plus routes crossing those spots are routed again (KORD: 10-150 ms per
     edit, 634 ms for an LED moved to a chain on the far side). Chains stay as routed (a moved LED keeps its place,
     a deleted one is spliced out, a new one goes where it costs least). A block, artwork, board or template change,
     or more than 5% of the LEDs at once, needs a full preview.
   - **Chains are never changed behind your back.** *Preview again* keeps every LED's current chain and position;
     *Re-chain + preview* (or *Assign chains*) assigns them again. While a preview is current the export uses its
     chains, so the Altium project routes what the overlay shows (the panel says which: "Export uses the chains of
     this preview" / "Export will assign chains").
   - **Problems are shown, not hidden.** Unrouted hops, caps that could only go over another part, and LED pairs whose
     pads are under 0.15 mm apart are listed in amber in the routing box and the export result (with *select* for the
     LEDs); the export still writes its files.
   - **Export Altium project…** asks for a folder and writes `<folder>/<IATA>/`: `.PrjPcb`, `.PcbDoc` with every
     LED, cap, 5SW via and the routed data lines, the schematic sheets, BOM, OutJobs, the zip, the generator's
     light map and `<id>_firmware_board.json`. The report (hops routed, vias, art on parts, DCDC gap) shows in the
     panel, and the routed chain order is written back to the LEDs.
   - The report lists the MCU data pin of every chain (read from the generated board by the generator) and the
     firmware definition carries them (`chains[].gpio`, `status_gpio`); an export whose pins cannot be derived fails.
   - **Install into flightboard** writes the firmware board definition to `../flightboard/boards/<id>.json` and
     runs the repo's `tools/gen_board_hpp.py`, which makes the constexpr `<id>.hpp` and `<id>_backdrop.hpp`. The
     id defaults to the board id; set **Firmware board id** to `ohare` to replace the current O'Hare definition.
     The ESP32 example reads the data pins from the board definition.

## Back silk (Bottom Overlay)

- **Imported art**: *File › Import back art…* takes a JSON list of polygons (or plain rings) in board mm, a pcbgen /
  Python build spec (`silk_back`), a pcbgen job (`art.silkBack`) or another flightboard project (its back art). The
  coordinates are the board's own (seen from the top, origin top-left, y down), exactly as printed on the Bottom
  Overlay, so text in the art reads mirrored from the front. The art is stored compactly in the project
  (`backArt`, micrometre deltas as base64 varints, `core/backart.ts`: the old Chicago street map, 11,995 polygons,
  is 1.2 MB instead of 15 MB), drawn as one path, and edited only as a whole in the **Layers** tab: show / export,
  front-view opacity, lock, move by x / y, mirror left-right (for art drawn as seen from the back), clear, replace.
  The import warns when the art leaves the board or the file names a different board size.
- **Drawn back silk**: any line, polygon or label can go on the *back silkscreen* layer (inspector, or the add
  presets in the LEDs tab for new ones) and is drawn in violet. Back labels are printed mirrored about their anchor
  so they read from the back; their rotation is the one seen from the back.
- **Front / back view**: the *Front view* / *Back view* button in the toolbar (or *View from back* in the Layers tab,
  or the badge on the canvas) mirrors the canvas left-right. Front view shows the back silk faint, as if seen
  through the board; back view shows it at full strength, reading as printed, with the front art and LEDs faint.
  Every tool keeps working in board coordinates; arrows and the rotation keys follow the screen.
- **Export**: `bottom_silk.svg` and the generator job's `art.silkBack` carry the imported art plus the drawn back
  items (strokes buffered, labels outlined and mirrored). The Layers toggle *Back silk* (and the imported art's
  *show and export*) decide whether it is exported; the PCB tab says what will go on the Bottom Overlay. The PCB
  export option *Clear back art around vias* (off by default: the vias are tented) cuts it around every via.
- Kord variant B with the Chicago map (`~/Documents/kord_variants/kord_B_with_back_art.flightboard.json`) exports
  11,995 Bottom Overlay regions, 7,940.3 mm², all inside the board outline (`pcbgen layerstats`).

## Code map

```
src/main/            Electron main: fetch (own user agent, no CORS), response cache, file dialogs, export folder,
                     pcbgen.ts (generator sidecar: find the executable, line-delimited JSON, progress, cancel)
src/preload/         window.api bridge
src/renderer/src/
  core/model.ts      data model (metres for geometry, mm for board and LED sizes), layer names, stroke widths
  core/geo.ts        WGS84 <-> UTM (proj4)
  core/transform.ts  metres -> board mm, board fitting
  core/geom.ts       JSTS wrapper (union, buffer, difference, indexing, length-indexed lines)
  core/osm.ts        Overpass queries with mirror fallback and tiling
  core/faa.ts        FAA AM_* feature-service fetch
  core/airports.ts   airport search (assets/data/airports-slim.csv)
  core/build.ts      raw data -> Project: frame, board, pavement, runways, markings, buildings, landside
  core/place.ts      LED placement (runways, gates, P1 taxiway/ramp rules)
  core/labels.ts     initial labels + north arrow
  core/markings.ts   runway markings: blast-pad chevrons, threshold arrows, designators, end chevrons with the designator inside
  core/export.ts     SVG / JSON exporters (opentype.js text outlines)
  core/path.ts       path editing math: split / join / cut, fillet / chamfer, offset, pathfinder, knife, shapes
  core/pcbjob.ts     project -> pcbgen-job/1 (art polygons, LEDs, block poses, options)
  core/backart.ts    imported back art: file formats, compact encoding, editor path, polygons for the exports
  core/pcbtypes.ts   generator replies (describe, check, chains, report) + block pose math shared with the canvas
  core/fwboard.ts    firmware board definition (flightboard schema 1) from the project + the routed chains
  stores/project.ts  Pinia store: shallow project + per-layer revisions, undo/redo, actions, files, task runner
  workers/           compute.worker.ts (heavy work off the page) + compute-types.ts (message contract)
  services/compute.ts  page side of the worker: requests, progress, cancel
  components/        AirportPanel, LayersPanel, PlacementPanel, PcbPanel, Inspector, EditorCanvas + layers/*, Toolbar,
                     PathMenu (shared by the toolbar, the right-click menu and the inspector), ContextMenu
```

Long-running work never runs on the page. `workers/compute.worker.ts` does the airport build, LED placement, label
generation and collision fitting, source application, export and the generator job; `services/compute.ts` talks to it (request ids,
streamed progress, cancel = terminate the worker and start a fresh one next time). Store actions wrap these in
`runTask`, which shows the fullscreen loader (`components/BusyOverlay.vue`): input is blocked at once, the card fades in
after 0.2 s so quick tasks do not flash, and it shows the step, elapsed time, a live status log and Cancel; a failed task
keeps the loader open with the error until dismissed. Network downloads stay in the Electron main process. Fonts are
inlined (`?inline`) so the exporter works in the worker and in a packaged app.

The generator runs in its own process: the store calls it over IPC (`pcbgen:call`), progress lines stream into the
same loader, and Cancel kills the process (the next call starts it again and reloads the job). The executable is
found in this order: `FB_PCBGEN`, the app's `resources/pcbgen`, the dev build `../pcbgen/gen/bin/Release/net10.0`,
then `../pcbgen/out/publish/<platform>`.

Scripted runs: `FB_BATCH=job.json pnpm dev` opens projects, optionally nudges labels marked `_resolve`, saves,
screenshots, exports and can run a perf suite (main-thread long tasks per operation); see `runBatch` in `App.vue`.

The project object is a shallow ref with plain arrays; every mutation goes through a store action that bumps the
matching revision (`rev.leds`, `rev.lines`, …), and the canvas layers are memoized on those revisions, so moving one
LED among 2000 costs a couple of milliseconds.

## Data notes

- Overpass: `maps.mail.ru` answers in seconds from this network; `overpass.kumi.systems` is often overloaded,
  `overpass.private.coffee` hangs, `overpass-api.de` refuses with 406. The last mirror that worked is tried first;
  each attempt is capped at 60 s. Use **Re-fetch** to bypass the cache.
- FAA coverage is US only; the log says when it falls back to OSM pavement.
- Fonts: Jost (OFL) regular and semibold, in `assets/fonts`, used both on screen and for exported outlines.
