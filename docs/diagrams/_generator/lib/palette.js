/**
 * Colour tokens for every diagram, in both themes.
 *
 * Node colours are SEMANTIC, not brand colours: a reader should be able to tell
 * "this is a Go service" from "this is a NestJS service" at a glance without a
 * legend. The one concession to branding is that Go services are cyan, because
 * that association is already in most readers' heads.
 */

/** @typedef {'client'|'edge'|'serviceTs'|'serviceGo'|'broker'|'store'|'observability'|'note'} Kind */

const LIGHT = {
  page: '#ffffff',
  ink: '#1e1e1e',
  inkMuted: '#5c5f66',
  frame: '#adb5bd',
  edge: '#495057',
  edgeAccent: '#e8590c',
  kinds: {
    client: { fill: '#e7f5ff', stroke: '#1971c2', text: '#0b4a8f' },
    edge: { fill: '#fff4e6', stroke: '#e8590c', text: '#8a3400' },
    serviceTs: { fill: '#f3f0ff', stroke: '#6741d9', text: '#432b95' },
    serviceGo: { fill: '#e3fafc', stroke: '#0c8599', text: '#08525e' },
    broker: { fill: '#fff9db', stroke: '#f08c00', text: '#7a4900' },
    store: { fill: '#f1f3f5', stroke: '#495057', text: '#212529' },
    observability: { fill: '#ebfbee', stroke: '#2f9e44', text: '#1a662c' },
    note: { fill: '#fff5f5', stroke: '#e03131', text: '#8f1c1c' },
  },
};

const DARK = {
  page: '#0d1117',
  ink: '#e6edf3',
  inkMuted: '#9198a1',
  frame: '#3d444d',
  edge: '#9198a1',
  edgeAccent: '#ff9a5c',
  kinds: {
    client: { fill: '#12283f', stroke: '#4dabf7', text: '#a9d3fb' },
    edge: { fill: '#3a2413', stroke: '#ff922b', text: '#ffd8a8' },
    serviceTs: { fill: '#241f3d', stroke: '#9775fa', text: '#d0bfff' },
    serviceGo: { fill: '#0f2f36', stroke: '#3bc9db', text: '#99e9f2' },
    broker: { fill: '#332a0f', stroke: '#fcc419', text: '#ffec99' },
    store: { fill: '#21262d', stroke: '#8b949e', text: '#c9d1d9' },
    observability: { fill: '#122b1a', stroke: '#51cf66', text: '#b2f2bb' },
    note: { fill: '#331b1b', stroke: '#ff6b6b', text: '#ffc9c9' },
  },
};

export const THEMES = { light: LIGHT, dark: DARK };

/**
 * Excalidraw ships a fixed colour picker and stores raw hex, so the .excalidraw
 * scene is generated from the LIGHT theme only. Excalidraw's own dark mode is a
 * canvas-level filter, so a light-authored scene renders correctly there anyway.
 */
export const EXCALIDRAW_THEME = LIGHT;
