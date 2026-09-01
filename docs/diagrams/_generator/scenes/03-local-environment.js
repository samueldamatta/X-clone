/**
 * Scene 3 — the local development topology, and the port map that goes with it.
 *
 * This exists now rather than as a placeholder because it is the one diagram that
 * becomes wrong the moment Phase 1 starts guessing: port collisions are cheap to
 * prevent on paper and annoying to untangle once nine compose services are
 * already written. The Kubernetes deployment diagram arrives at Phase 11, when
 * there is something real to deploy.
 */

import { row } from '../lib/scene.js';

const appsA = row({ count: 5, left: 70, right: 1410, y: 140, h: 64, gap: 26 });
const appsB = row({ count: 5, left: 70, right: 1410, y: 250, h: 64, gap: 26 });
const infra = row({ count: 5, left: 70, right: 1410, y: 430, h: 64, gap: 26 });
// The collector is not a peer of the backends it feeds, so it does not belong
// in their row: a left-to-right arrow from it to Prometheus would cut straight
// through Jaeger and imply a hop that does not exist.
const obsBackends = row({ count: 3, left: 250, right: 1230, y: 730, h: 64, gap: 30 });

export default {
  name: '03-local-environment',
  title: 'X-clone — Local Development Environment',
  subtitle: 'One `docker compose up` · every port assigned once, here, before any of it is written',
  width: 1480,
  height: 1010,

  frames: [
    { label: 'Application containers', x: 40, y: 110, w: 1400, h: 250 },
    { label: 'Infrastructure containers', x: 40, y: 400, w: 1400, h: 124 },
    { label: 'Observability containers', x: 40, y: 556, w: 1400, h: 264 },
  ],

  nodes: [
    { id: 'fe', kind: 'client', ...appsA[0], label: 'frontend', sub: 'Next.js · :3000' },
    { id: 'gw', kind: 'edge', ...appsA[1], label: 'gateway', sub: 'NestJS · :8080' },
    { id: 'identity', kind: 'serviceTs', ...appsA[2], label: 'identity', sub: 'NestJS · :8081' },
    { id: 'tweet', kind: 'serviceTs', ...appsA[3], label: 'tweet', sub: 'NestJS · :8082' },
    { id: 'media', kind: 'serviceTs', ...appsA[4], label: 'media', sub: 'NestJS · :8083' },

    { id: 'graph', kind: 'serviceGo', ...appsB[0], label: 'graph', sub: 'Go · gRPC :50051' },
    { id: 'timeline', kind: 'serviceGo', ...appsB[1], label: 'timeline', sub: 'Go · :8086' },
    { id: 'fanout', kind: 'serviceGo', ...appsB[2], label: 'fanout-worker', sub: 'Go · metrics :9101' },
    { id: 'notify', kind: 'serviceTs', ...appsB[3], label: 'notification', sub: 'NestJS · :8084 + WS' },
    { id: 'search', kind: 'serviceTs', ...appsB[4], label: 'search', sub: 'NestJS · :8085' },

    { id: 'pg', kind: 'store', ...infra[0], label: 'postgres', sub: ':5432 · schema per svc' },
    { id: 'redis', kind: 'store', ...infra[1], label: 'redis', sub: ':6379' },
    { id: 'redpanda', kind: 'broker', ...infra[2], label: 'redpanda', sub: ':9092 · console :8090' },
    { id: 'opensearch', kind: 'store', ...infra[3], label: 'opensearch', sub: ':9200 · --profile search' },
    { id: 'minio', kind: 'store', ...infra[4], label: 'minio', sub: ':9000/:9001 · --profile media' },

    { id: 'otelcol', kind: 'observability', x: 580, y: 586, w: 320, h: 64, label: 'otel-collector', sub: 'OTLP :4317 / :4318' },
    { id: 'jaeger', kind: 'observability', ...obsBackends[0], label: 'jaeger', sub: 'UI :16686' },
    { id: 'prom', kind: 'observability', ...obsBackends[1], label: 'prometheus', sub: ':9090' },
    { id: 'grafana', kind: 'observability', ...obsBackends[2], label: 'grafana', sub: 'UI :3001' },
  ],

  edges: [
    { from: 'fe', to: 'gw', label: 'HTTP' },
    { from: 'otelcol', to: 'jaeger', label: 'traces', elbow: 0.25 },
    { from: 'otelcol', to: 'prom', label: 'metrics', style: 'dashed' },
    { from: 'prom', to: 'grafana', label: 'query' },
  ],

  notes: [
    {
      x: 740,
      y: 850,
      align: 'center',
      size: 12.5,
      text:
        'Redpanda replaces Kafka locally: same protocol and client libraries, one binary, no ZooKeeper, a fraction of the RAM.\nProduction targets real Kafka — nothing in application code knows the difference.\n\nEvery service ships traces and metrics to the collector, never straight to a backend. Swapping Jaeger for Tempo then costs one config file, not nine.\n\nMinIO and OpenSearch sit behind compose profiles — nothing consumes them until Phases 6 and 8, and they hold ~1 GB between them.',
    },
  ],
};
