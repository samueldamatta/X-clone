/**
 * Scene 1 — the container-level view of the whole system.
 *
 * Editorial rule for this diagram: it shows STRUCTURE, not every call. Arrows are
 * reserved for the flows that define the system (request path, event path). The
 * service-to-datastore relationships live in each store's subtitle instead,
 * because drawing them would put six lines across the Kafka band and cost more
 * legibility than the information is worth. Detailed flow is scene 2's job, and
 * step-by-step ordering is the Mermaid sequence diagrams' job.
 *
 * Colour is load-bearing: violet = NestJS/TypeScript, cyan = Go. Each box also
 * states its runtime in the subtitle, so the diagram survives being printed in
 * greyscale or read by someone who is colour-blind.
 */

import { row } from '../lib/scene.js';

const clients = row({ count: 2, left: 340, right: 880, y: 130, h: 56, gap: 40 });
const services = row({ count: 5, left: 70, right: 1150, y: 420, h: 70, gap: 26 });
const consumers = row({ count: 3, left: 209, right: 1011, y: 712, h: 70, gap: 32 });
const stores = row({ count: 4, left: 70, right: 1150, y: 862, h: 56, gap: 32 });

const obs = [430, 560, 690, 820].map((y) => ({ x: 1250, y, w: 170, h: 56 }));

export default {
  name: '01-system-architecture',
  title: 'X-clone — System Architecture',
  subtitle:
    'Hybrid service split · NestJS on request-shaped work, Go on the hot path · Kafka as the event backbone',
  width: 1480,
  height: 990,

  frames: [
    { label: 'Clients', x: 40, y: 110, w: 1140, h: 96 },
    { label: 'Edge', x: 40, y: 250, w: 1140, h: 96 },
    { label: 'Services', x: 40, y: 392, w: 1140, h: 116 },
    { label: 'Event backbone', x: 40, y: 552, w: 1140, h: 86 },
    { label: 'Event consumers', x: 40, y: 682, w: 1140, h: 116 },
    { label: 'Data stores', x: 40, y: 842, w: 1140, h: 96 },
    { label: 'Observability', x: 1230, y: 392, w: 210, h: 546 },
  ],

  nodes: [
    // --- Clients -------------------------------------------------------------
    { id: 'web', kind: 'client', ...clients[0], label: 'Web App', sub: 'Next.js 15' },
    { id: 'mobile', kind: 'client', ...clients[1], label: 'Mobile', sub: 'future' },

    // --- Edge ----------------------------------------------------------------
    { id: 'cdn', kind: 'edge', x: 120, y: 270, w: 220, h: 56, label: 'CDN', sub: 'media + static' },
    {
      id: 'gateway',
      kind: 'edge',
      x: 460,
      y: 270,
      w: 300,
      h: 56,
      label: 'API Gateway / BFF',
      sub: 'JWT · rate limit · aggregation',
    },

    // --- Request-serving services -------------------------------------------
    { id: 'identity', kind: 'serviceTs', ...services[0], label: 'Identity', sub: 'NestJS' },
    { id: 'tweet', kind: 'serviceTs', ...services[1], label: 'Tweet', sub: 'NestJS · outbox' },
    { id: 'graph', kind: 'serviceGo', ...services[2], label: 'Graph', sub: 'Go · gRPC' },
    { id: 'timeline', kind: 'serviceGo', ...services[3], label: 'Timeline API', sub: 'Go · hybrid read' },
    { id: 'media', kind: 'serviceTs', ...services[4], label: 'Media', sub: 'NestJS · presigned' },

    // --- Event backbone ------------------------------------------------------
    {
      id: 'kafka',
      kind: 'broker',
      x: 70,
      y: 572,
      w: 1080,
      h: 46,
      label: 'Kafka  ·  event backbone',
      sub: 'tweet.created · tweet.deleted · user.followed · tweet.liked · user.registered  (+ DLQ per topic)',
    },

    // --- Event consumers -----------------------------------------------------
    { id: 'fanout', kind: 'serviceGo', ...consumers[0], label: 'Fanout Worker', sub: 'Go · writes timelines' },
    {
      id: 'notify',
      kind: 'serviceTs',
      ...consumers[1],
      label: 'Notification',
      sub: 'NestJS · WebSocket push',
    },
    { id: 'search', kind: 'serviceTs', ...consumers[2], label: 'Search', sub: 'NestJS · indexer' },

    // --- Data stores ---------------------------------------------------------
    {
      id: 'postgres',
      kind: 'store',
      ...stores[0],
      label: 'PostgreSQL',
      sub: 'write model · schema per service',
    },
    { id: 'redis', kind: 'store', ...stores[1], label: 'Redis', sub: 'timelines · cache · rate limits' },
    { id: 'opensearch', kind: 'store', ...stores[2], label: 'OpenSearch', sub: 'search + trends read model' },
    { id: 'minio', kind: 'store', ...stores[3], label: 'MinIO', sub: 'S3-compatible media objects' },

    // --- Observability -------------------------------------------------------
    { id: 'otel', kind: 'observability', ...obs[0], label: 'OpenTelemetry', sub: 'SDK in every service' },
    { id: 'jaeger', kind: 'observability', ...obs[1], label: 'Jaeger', sub: 'distributed traces' },
    { id: 'prom', kind: 'observability', ...obs[2], label: 'Prometheus', sub: 'metrics' },
    { id: 'grafana', kind: 'observability', ...obs[3], label: 'Grafana', sub: 'dashboards + SLOs' },
  ],

  edges: [
    { from: 'web', to: 'gateway', label: 'HTTPS' },
    { from: 'mobile', to: 'gateway' },
    { from: 'web', to: 'cdn', fromT: 0.12, style: 'dashed', label: 'media' },

    { from: 'gateway', to: 'identity', fromT: 0.12, elbow: 0.25 },
    { from: 'gateway', to: 'tweet', fromT: 0.37, elbow: 0.7, accent: true, label: 'write' },
    { from: 'gateway', to: 'timeline', fromT: 0.63, elbow: 0.7, accent: true, label: 'read' },
    { from: 'gateway', to: 'media', fromT: 0.88, elbow: 0.25 },

    { from: 'timeline', to: 'graph', label: 'gRPC' },

    { from: 'tweet', to: 'kafka', accent: true, label: 'outbox → publish' },
    { from: 'kafka', to: 'fanout', fromT: 0.243, accent: true, label: 'tweet.created' },
    { from: 'kafka', to: 'notify', fromT: 0.5, style: 'dashed', label: 'likes · follows · mentions' },
    { from: 'kafka', to: 'search', fromT: 0.757, style: 'dashed', label: 'index' },

    { from: 'fanout', to: 'redis', accent: true, label: 'LPUSH × followers' },
  ],

  notes: [
    {
      x: 800,
      y: 268,
      size: 12.5,
      text:
        'Rate limiting is enforced here, not per service:\ntoken bucket in Redis, keyed by user and by IP.\nOne place to reason about abuse, one place to tune.',
    },
    {
      x: 610,
      y: 952,
      align: 'center',
      size: 12.5,
      tone: 'accent',
      text:
        'The orange path is the write→read loop that defines the system. How it splits for celebrities is scene 02-hybrid-fanout.',
    },
  ],
};
