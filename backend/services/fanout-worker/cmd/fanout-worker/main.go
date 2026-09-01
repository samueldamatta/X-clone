// Command fanout-worker is a placeholder.
//
// It exists so that go.work resolves and CI has something to vet and build.
// It deliberately does not start a server: fanout-worker listens on metrics :9101 and consumes tweet.created and writes Redis,
// and none of that exists until Phase 4. A stub that opened a port and
// answered /healthz would report a service that is healthy in the sense of
// being incapable of failing, which is the least useful kind of green.
//
// What it does establish is the shutdown contract every service here keeps:
// block until the process is asked to stop, then stop deliberately. Retrofitting
// that later means discovering, in Phase 4, that SIGTERM kills the fanout worker
// mid-batch.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

const serviceName = "fanout-worker"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", serviceName)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Info("started", "state", "placeholder", "implemented_in", "phase 4")

	<-ctx.Done()
	log.Info("shutting down", "reason", context.Cause(ctx))
}
