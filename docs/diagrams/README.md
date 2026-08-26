# Diagrams

Three scenes, each generated from a single layout specification into two outputs:

| Output | Purpose |
|---|---|
| `<name>.excalidraw` | Editable scene — open it at [excalidraw.com](https://excalidraw.com) |
| `<name>-light.svg` / `<name>-dark.svg` | README images, one per colour scheme |

## Building

```bash
node docs/diagrams/_generator/build.mjs
```

No install step. Zero dependencies, plain ESM, Node 18+. This is deliberate: the generator
should still run in three years without a lockfile or an abandoned package.

## Scenes

| Scene | Shows |
|---|---|
| `01-system-architecture` | The container-level view — clients, edge, services, event backbone, data stores |
| `02-hybrid-fanout` | The timeline fan-out decision, both paths side by side |
| `03-local-environment` | The docker-compose topology and the port map |

## Editing

**Change the layout spec** in [`_generator/scenes/`](_generator/) and rebuild. This keeps
the `.excalidraw` file and both SVGs in agreement.

**Or edit the `.excalidraw` by hand** at excalidraw.com for a one-off tweak — but then the
SVGs are stale. Re-export them via *File → Export image → SVG*, or fold the change back into
the scene spec and rebuild. The spec is the source of truth; the honest caveat is that
nothing mechanically enforces that.

## Why the SVG is generated rather than exported

Excalidraw's own SVG export needs its rendering engine, which needs a browser. Rather than
add a headless-browser dependency to a docs build, the generator emits clean SVG from the
same layout data. Consequence: the SVGs are geometric rather than hand-drawn, while the
`.excalidraw` file carries the sketchy style when opened in Excalidraw.

## Why two SVGs instead of one

GitHub renders README images inside an `<img>` tag, and an `<img>`-embedded SVG cannot see
the host page's colour scheme — a `prefers-color-scheme` media query inside it always
resolves to light. So the README uses `<picture>` with two sources, which GitHub does
honour.

## What the build checks

The generator refuses to emit a diagram that is wrong in ways that are hard to see:

- Nodes off-canvas, or overlapping each other
- Edges referencing nodes that do not exist
- **Arrows passing through unrelated boxes** — which reads as a connection that is not there,
  so the picture would actively lie
- Arrows crossing text labels
- Labels and notes overlapping each other
- Notes overflowing the canvas
- Malformed SVG output (unbalanced attribute quotes)

Every one of these was added after it actually happened. To verify the output independently:

```bash
for f in docs/diagrams/*.svg; do
  python3 -c "import xml.dom.minidom as m; m.parse('$f'); print('ok', '$f')"
done
```

## Colour convention

Colour carries meaning, and every box also states its runtime in the subtitle so the
diagrams survive greyscale printing and colour-blind readers.

| | Meaning |
|---|---|
| Blue | Clients |
| Orange | Edge — gateway, CDN |
| Violet | NestJS / TypeScript service |
| Cyan | Go service |
| Yellow | Kafka |
| Grey | Data store |
| Green | Observability |

Orange arrows mark the write→read loop that defines the system.
