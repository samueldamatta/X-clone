# Internal gRPC

## The problem

Nine services have to talk to each other. The Gateway asks Identity to create an account.
The Fanout Worker asks Graph who follows an author — on **every tweet**. Timeline asks Tweet
to hydrate fifty ids at once.

Meanwhile, the outside world gets REST over HTTPS, because browsers and the people writing
clients expect it.

These two surfaces have almost nothing in common. The public one is versioned carefully,
documented, and changed slowly because clients we do not control depend on it. The internal
one is called by code we own, deployed together, and changes whenever both sides agree.
Pretending they are the same problem is how one of them ends up solved badly.

## Why the obvious answers fail

### REST and JSON internally too

One protocol everywhere. Curl-able. No new tooling.

It breaks on three counts, and only the third is about speed.

**There is no shared contract.** The Gateway sends `{"handle": "...", "password": "..."}` and
Identity reads it. Rename the field on one side and nothing complains — not at compile time,
not at deploy time. It fails on the first request in production, which is 3am, which is the
worst possible moment to learn about a typo.

**Serialisation is not free at fan-out volume.** From
[`02-capacity-estimation.md`](../02-capacity-estimation.md): Tier 2 is 500,000 tweets a day,
and every one of them makes the Fanout Worker call Graph for the author's followers. At peak
that is 30 calls a second, each returning on average 200 ids — and those 200 ids are the
cheap part, because the 100,000,000 daily fan-out writes they produce all descend from
them. JSON parsing there is not an academic cost; protobuf is roughly 3-5× smaller on the
wire and avoids parsing numbers out of text entirely.

**Unbounded results have nowhere to go.** `GET /users/123/followers` for an account with 40
million followers has two options in REST: return all of them (gigabytes in the worker's
memory, and a timeout long before it finishes) or paginate with a cursor the caller has to
loop over by hand. Neither is a stream.

### Everything through Kafka

The event backbone already exists ([[async-event-backbone]]), so why not use it for
everything?

Because request/response over a broker is a different shape of problem wearing the same
clothes. You publish a request, you subscribe to a reply topic, you correlate by id, you
decide what to do when the reply never arrives. You have rebuilt RPC, badly, on top of
something designed for one-way facts.

And the deciding case is right here: someone clicked "sign up" and is watching a spinner.
That request is synchronous by nature. Events are for facts about the past that other
services care about *afterwards* — `user.registered`, not "please register a user".

### A shared library instead of a network call

The fastest RPC is the one that does not happen. Put the code in a package, import it.

This is genuinely the right answer for some systems, and it is the one ADR
[0001](../adr/0001-hybrid-services-over-monolith.md) deliberately rejects: the whole point of
this project is exercising what real Twitter does at real scale, and a shared library gives
up independent deployment and independent scaling.

## gRPC

Protobuf schemas live in [`backend/libs/proto/`](../../backend/libs/proto/) and are the
single source of truth for both sides of every internal call.

```protobuf
service IdentityService {
  rpc Register(RegisterRequest) returns (RegisterResponse);
}

message RegisterRequest {
  string handle = 1;
  string password = 2;
}
```

Two rules will govern every service definition here, both learned from systems that got them
wrong. Neither is visible in the code yet — `identity.proto` holds one unary RPC, and the
services these examples name arrive in Phases 3 and 4 ([`04-api-contracts.md`](../04-api-contracts.md)
carries the planned surface). They are written down now because retrofitting either one
means changing a contract both sides already depend on.

**Batch by default.** `GetTweets` will take a list of ids. If it took one, hydrating a
timeline page would be fifty sequential round trips and the read path's latency would be
dominated by network overhead rather than by work.

**Stream unbounded results.** `GetFollowers` will return a stream of batches. The 40-million
follower case stops being a memory problem and becomes a loop.

## The part that is easy to get wrong: errors

A gRPC status is a code and a message. That is all. There is no structured payload, and the
public API has promised something a code cannot express: **which field was wrong**.

RFC 9457 problem details say the response should name it:

```json
{ "type": "about:blank", "title": "Conflict", "status": 409, "field": "handle" }
```

The proper protobuf answer is `google.rpc.BadRequest`, a message carrying a list of field
violations, attached to the status as a detail. This repository does something smaller: one
metadata key, `x-field-violation`, holding a JSON object with `field` and `reason`. Every
validation failure in this system rejects exactly one field, so a list is a shape we would
never fill.

**What that costs:** a repository-local convention instead of a standard one. Any tool that
understands `google.rpc.BadRequest` — and some do — will not understand this. The day a
second field needs naming, the key changes shape and both sides change with it. That is
cheap now and would not be if the surface were large.

### Following one failure end to end

Registering a handle that is taken:

1. `RegisterUserUseCase` throws `HandleTakenError`, which knows its field is `handle`.
2. Identity's gRPC controller turns it into `ALREADY_EXISTS` and attaches
   `x-field-violation: {"field":"handle","reason":"..."}`.
3. The Gateway's client receives a `ServiceError` with that metadata intact.
4. `toProblemDetails` maps `ALREADY_EXISTS` → `409 Conflict` and reads the field back out.
5. The browser gets the JSON above, and paints one input red.

Step 3 is why the Gateway uses `@grpc/grpc-js` directly rather than Nest's `ClientGrpc`
wrapper: the metadata only exists on the raw error, and every layer that repackages it is a
layer where it can be dropped.

### Which code becomes which status

| gRPC | HTTP | Why this one |
|---|---|---|
| `INVALID_ARGUMENT` | 400 | The caller sent something wrong |
| `UNAUTHENTICATED` | 401 | |
| `PERMISSION_DENIED` | 403 | |
| `NOT_FOUND` | 404 | |
| `ALREADY_EXISTS` | 409 | |
| `RESOURCE_EXHAUSTED` | 429 | Nothing raises it until rate limiting lands |
| `DEADLINE_EXCEEDED` | **504** | We stopped waiting — the write may still have landed |
| `UNAVAILABLE` | 503 | |
| anything else | 500 | We are broken |

The 504 is the interesting one. It is not 500, because 500 says "your request failed" and a
deadline says something weaker and more dangerous: *we do not know*. A client that retries a
504 on a non-idempotent write may create two accounts.

**One rule governs the message.** A 4xx detail is forwarded, because the service that
rejected the caller wrote that sentence *for* the caller — "must be at least 8 characters"
is useful. A 5xx detail is dropped, because that one was written for us:
`connect ECONNREFUSED 10.0.1.7:8081` tells an attacker the shape of the internal network and
tells the caller nothing they can act on.

## Deadlines are not optional

A gRPC call without a deadline waits forever, and "forever" is not an abstraction. The
request handler behind it stays parked holding its socket; enough of those and the Gateway
runs out of connections because one downstream service hung instead of failing.

Every call in this repository carries one. Identity's `Register` gets 5 seconds — generous
for a call whose slowest legitimate step is one argon2id hash (~100 ms, deliberately), which
is what makes tripping the deadline mean something.

## What it costs

- **Not curl-able.** Debugging needs `grpcurl` or a test client. The Gateway is the only
  thing a browser can talk to, which is also the point.
- **Hand-written TypeScript types.** The `.proto` is loaded at runtime with
  `@grpc/proto-loader` rather than compiled with `ts-proto`, so
  [`types.ts`](../../backend/libs/proto/src/identity/v1/types.ts) mirrors the schema by hand
  and nothing keeps the two in step automatically. A field renamed in the `.proto` fails at
  the call site, not at compile time. Acceptable while this package holds one RPC; the fix
  when it stops being acceptable is codegen, and the trigger is the surface growing.
- **A translation layer that must exist.** Someone has to turn statuses into HTTP and
  metadata into problem details. That someone is the Gateway, in
  [`grpc-problem-details.ts`](../../backend/gateway/src/infrastructure/grpc/grpc-problem-details.ts).
- **Two protocols to understand** instead of one.

## In this repository

| Where | What |
|---|---|
| [`backend/libs/proto/`](../../backend/libs/proto/) | The `.proto` files, the hand-written types, and the field-violation helpers |
| [`identity/presentation/grpc/`](../../backend/services/identity/src/presentation/grpc/) | The server side: domain errors → gRPC statuses |
| [`gateway/infrastructure/identity/`](../../backend/gateway/src/infrastructure/identity/) | The client side: channel, deadline, promisification |
| [`gateway/infrastructure/grpc/`](../../backend/gateway/src/infrastructure/grpc/) | Statuses → RFC 9457 problem details |
| [`scripts/integration.sh`](../../scripts/integration.sh) | The only test that proves the two halves fit, in containers |

Full contract surface: [`04-api-contracts.md`](../04-api-contracts.md). Built in Phase 2;
`GetFollowers` and the streaming rule arrive with Phase 4.

## Related

[[async-event-backbone]] · [[snowflake-ids]] · [[local-environment]]
