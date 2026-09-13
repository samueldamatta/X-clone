# API Contracts

Two surfaces, with different rules.

The **public edge** is REST over HTTPS, served only by the Gateway. It is versioned,
documented, and changed carefully because clients we do not control depend on it.

The **internal surface** is gRPC with protobuf. It is not public, it is not REST, and it is
not negotiable per-service: protobuf schemas live in [`backend/libs/proto/`](../backend/libs/)
and are the single source of truth for both sides of every internal call.

Why gRPC internally: Fanout→Graph runs on every tweet, so serialisation cost is not
academic; and a `.proto` file makes a breaking change visible at build time instead of at
3am.

## Conventions

- Cursor pagination everywhere: `?cursor=<snowflake>&limit=50`. Never `OFFSET` — it skips
  and repeats items when new content arrives mid-scroll.
- All ids are Snowflake integers, serialised as **strings** in JSON. JavaScript's
  `Number.MAX_SAFE_INTEGER` is 2^53−1; a 64-bit id silently loses precision as a JSON
  number. This is a real bug that ships often.
- Errors follow [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457), served as
  `application/problem+json`. One extension member is added: **`field`**, naming the single
  request field that caused the failure. Every validation error in this system rejects
  exactly one field, so a list — as `google.rpc.BadRequest` would carry — is a shape that
  would never be filled. Internally it travels as gRPC metadata; see
  [`concepts/internal-grpc.md`](concepts/internal-grpc.md).

  ```json
  { "type": "about:blank", "title": "Conflict", "status": 409, "field": "handle" }
  ```

  `title` names the problem *type* and does not vary between occurrences; `detail` is
  specific to the one at hand, and is omitted entirely on 5xx — that message was written
  for us, not for the caller.

  `field` is present on validation failures and absent everywhere else. There are two
  exceptions, both deliberate, both in the Identity section below:

  - **A rejected login** names no field. Naming one would say whether the handle exists.
  - **A rejected access token** names none either, for the same class of reason.
  - **A `PATCH` that asks for nothing** names none, because there is no single field at
    fault — the body as a whole is.
- Every response carries `X-Request-Id`, propagated as the OpenTelemetry trace id.
  *Not built yet — wiring it is [#12](https://github.com/samueldamatta/X-clone/issues/12).*

## Public REST surface

### Identity

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/auth/register` | Create an account |
| `POST` | `/v1/auth/login` | Exchange credentials for an access + refresh token pair |
| `POST` | `/v1/auth/refresh` | Rotate the refresh token, issue a new access token |
| `POST` | `/v1/auth/logout` | Revoke the current session |
| `GET` | `/v1/users/{handle}` | Public profile, no authentication |
| `PATCH` | `/v1/users/me` | Update own profile, authenticated |

Access tokens are short-lived JWTs (15 min) verified at the Gateway without a network hop.
Refresh tokens are opaque, stored hashed, and **rotated on every use** — reuse of a spent
refresh token revokes the whole session chain, which is how you detect a stolen token.
Rotation and reuse detection are [#8](https://github.com/samueldamatta/X-clone/issues/8);
login itself is built. The reasoning behind the split is in
[`concepts/access-and-refresh-tokens.md`](concepts/access-and-refresh-tokens.md).

```jsonc
// POST /v1/auth/login
{ "handle": "sam", "password": "correcthorse1" }

// 200 OK — not 201: a session is created, but no URL addresses it
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxODQ3…",
  "accessTokenExpiresAt": "2026-09-11T12:15:00.000Z",
  "refreshToken": "3q2-7_9RkTZ8xN1pQvLmYbCdEfGhIjKlMnOpQrStUvW",
  "refreshTokenExpiresAt": "2026-10-11T12:00:00.000Z",
  "userId": "1847100000001"      // string, not a number
}
```

The client sends the access token as `Authorization: Bearer <accessToken>` — see
**Authenticated requests** below for what the Gateway does with it.

**A failed login answers `401` with no `field` member, and the body is byte-for-byte the
same for an unknown handle as for a wrong password.** This is the one place in the API where
the `field` convention above is deliberately not followed — the first of the three
exceptions listed there: naming which half was wrong turns the endpoint into an
account-enumeration oracle. A body that is not a JSON object with two
strings is a `400`, also without a `field`, and also with one fixed message.

#### Profiles

```jsonc
// GET /v1/users/sam — no Authorization header, by design: a profile is
// what a shared link points at, and a logged-out visitor must be able to
// read one.
// 200 OK
{
  "id": "92401505176391680",     // string, not a number
  "handle": "sam",
  "displayName": "Samuel",
  "bio": "building a twitter clone",
  "createdAt": "2026-09-12T23:30:35.571Z"
}
```

**`id` and `handle` are both there on purpose.** A handle can be renamed; the Snowflake
cannot. Anything that has to survive a rename — a mention, a bookmark, a follow row — refers
to `id`, and `handle` is only how a human addresses the account.

There is no `followerCount`. The column exists in `identity.users`, and nothing writes it
until the Graph service exists, in Phase 3 ([`05-roadmap.md`](05-roadmap.md)). Publishing it
now would mean every profile reporting zero followers as a fact.

An unknown handle is a `404`. Unlike a failed login, this endpoint is an existence oracle by
design — anyone can ask whether `@sam` is taken by visiting the page — so there is nothing
left for a vague answer to protect.

```jsonc
// PATCH /v1/users/me
// Authorization: Bearer <accessToken>
{ "displayName": "Samuel", "bio": "" }

// 200 OK — the profile as it now stands
{ "id": "92401505176391680", "handle": "sam", "displayName": "Samuel", "bio": "", … }
```

**`me`, not `{id}`.** The account being edited comes from the access token and from nowhere
else. There is no field in the request — path, query or body — that could name a different
one, which is how "an account cannot edit anyone else's profile" is enforced: not by a check
that could be forgotten, but by a request that has nowhere to say it. (A handle is 3-20
characters, so no account can ever be called `me`, and the two routes cannot collide.)

**Omitted means "leave it alone"; `""` means "clear it".** Sending only `displayName` leaves
the bio untouched. Sending `"bio": ""` empties it. The two are carried apart all the way to
the database, which is why `display_name` and `bio` are `optional` in `identity.proto` —
proto3 gives a plain `string` no field presence, and collapsing the two would mean a rename
silently erasing a bio. `null` is refused rather than read as "clear": this API already
spells that instruction `""`.

Fields the API does not know are ignored, so `{"displayname": "Sam"}` — wrong case — parses
to a patch that asks for nothing, and **a patch that asks for nothing is a `400`**. Accepting
it and answering `200` would be idempotent and defensible; it was rejected because a typo
would then look exactly like a success.

`200` rather than `204`: the response carries the profile as stored, so a client can see
what normalisation did to what it sent — a display name is trimmed, and CRLF in a bio is
folded to LF.

#### Authenticated requests

Send the access token as `Authorization: Bearer <accessToken>`. The Gateway verifies it
locally, with no call to Identity — that is the whole reason the access token is a JWT, and
[`concepts/verifying-jwts-at-the-edge.md`](concepts/verifying-jwts-at-the-edge.md) covers
both what it buys and what it costs.

**Every rejected token gets the identical response.** Absent, malformed, expired, tampered,
signed with the wrong key: one `401`, one body, byte for byte, with no `detail` and no
`field`.

```jsonc
// 401 Unauthorized
// WWW-Authenticate: Bearer
{ "type": "about:blank", "title": "Unauthorized", "status": 401 }
```

Telling a client its token *expired* would tell anyone else that the token they are holding
is genuine and that only the clock stopped them — a different next move from "your forgery
was wrong". `WWW-Authenticate` is present because RFC 7235 requires it on a 401, and bare
because RFC 6750's `error="invalid_token"` / `error="expired_token"` parameters would put
that distinction straight back.

One inconsistency, stated rather than hidden: the `401` from a failed **login** carries no
`WWW-Authenticate` header. Strictly, RFC 7235 asks for one on every 401. Sending "retry with
a bearer token" to a client that just submitted a password would be advice it cannot act on,
so that endpoint deviates on purpose.

### Graph

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/users/{id}/follow` | Follow |
| `DELETE` | `/v1/users/{id}/follow` | Unfollow |
| `GET` | `/v1/users/{id}/followers` | Paginated followers |
| `GET` | `/v1/users/{id}/following` | Paginated following |

### Tweets

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/tweets` | Create (optionally a reply, quote, or retweet) |
| `GET` | `/v1/tweets/{id}` | Single tweet |
| `DELETE` | `/v1/tweets/{id}` | Soft delete |
| `GET` | `/v1/tweets/{id}/replies` | Reply thread |
| `PUT` | `/v1/tweets/{id}/like` | Like (idempotent) |
| `DELETE` | `/v1/tweets/{id}/like` | Unlike (idempotent) |

`PUT`/`DELETE` for likes rather than `POST` is deliberate: double-tapping a heart on a
flaky connection must not produce two likes.

```jsonc
// POST /v1/tweets
{
  "body": "hello world",
  "inReplyToId": null,
  "quotedTweetId": null,
  "mediaIds": ["1847362819374"]      // strings, not numbers
}

// 201 Created
{
  "id": "1847362819999",
  "authorId": "1847100000001",
  "body": "hello world",
  "likeCount": 0,
  "createdAt": "2026-08-20T12:00:00Z"
}
```

The response returns before fan-out has happened. The tweet exists; it is simply not yet in
anyone's timeline. Clients should render it optimistically — see the note on eventual
consistency below.

### Timeline

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/timeline/home` | Hybrid home timeline — the hot path |
| `GET` | `/v1/timeline/user/{id}` | A user's profile timeline |

### Media

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/media/upload-url` | Request a presigned upload URL |
| `GET` | `/v1/media/{id}` | Metadata and processing status |

Bytes go **directly** from the browser to object storage using the presigned URL. They
never pass through the API. Proxying uploads through application servers is how you turn a
media feature into an availability incident.

### Search & notifications

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/search/tweets?q=` | Full-text tweet search |
| `GET` | `/v1/search/users?q=` | User search |
| `GET` | `/v1/trends` | Trending topics |
| `GET` | `/v1/notifications` | Paginated notifications |
| `WS` | `/v1/notifications/stream` | Real-time push |

## Internal gRPC surface

```protobuf
service GraphService {
  // Called on every fan-out. Streams because a large account's follower list
  // must never be materialised in the worker's memory all at once.
  rpc GetFollowers(GetFollowersRequest) returns (stream FollowerBatch);
  rpc GetFollowedCelebrities(UserRef) returns (CelebrityList);
  rpc IsFollowing(FollowPair) returns (BoolValue);
  rpc GetFollowerCount(UserRef) returns (CountValue);
}

service TweetService {
  rpc CreateTweet(CreateTweetRequest) returns (Tweet);
  // Batch by default: hydration fetches 50 at a time, never one at a time.
  rpc GetTweets(TweetIdList) returns (TweetList);
  rpc DeleteTweet(TweetRef) returns (google.protobuf.Empty);
}

service TimelineService {
  rpc GetHomeTimeline(TimelineRequest) returns (TimelinePage);
  rpc GetUserTimeline(TimelineRequest) returns (TimelinePage);
}

service IdentityService {
  // Register and Login exist. GetUsers arrives in Phase 4, with the batched
  // hydration that is its first consumer.
  rpc Register(RegisterRequest) returns (RegisterResponse);
  rpc Login(LoginRequest) returns (LoginResponse);
  rpc GetUsers(UserIdList) returns (UserList);
}
```

**There is deliberately no `VerifyToken`.** An earlier draft of this document listed one,
and it contradicted the reason the access token is a JWT at all: if the Gateway has to call
Identity to check a token, the network hop that the JWT exists to avoid is back, on every
authenticated request. The Gateway verifies the signature itself with the shared secret —
see [`concepts/access-and-refresh-tokens.md`](concepts/access-and-refresh-tokens.md).

Two design rules visible above, both learned from systems that got them wrong:

**Batch by default.** `GetTweets` takes a list. If it took one id, hydration would issue 50
sequential round trips per timeline page, and the read path's latency would be dominated by
network overhead rather than work.

**Stream unbounded results.** `GetFollowers` streams. A unary call returning 40 million ids
would allocate gigabytes in the worker and time out long before it finished.

## Kafka event contracts

Events are facts about the past. They are named in the past tense, they are immutable, and
they carry everything a consumer needs so it never has to call back into the producer.

| Topic | Producer | Consumers | Key |
|---|---|---|---|
| `tweet.created` | Tweet | Fanout, Search, Notification | `authorId` |
| `tweet.deleted` | Tweet | Fanout, Search | `authorId` |
| `tweet.liked` | Tweet | Notification, counters | `tweetId` |
| `user.followed` | Graph | Notification, counters | `followeeId` |
| `user.registered` | Identity | Search, Notification | `userId` |

```jsonc
// tweet.created
{
  "eventId": "1847362820000",        // for consumer-side deduplication
  "occurredAt": "2026-08-20T12:00:00Z",
  "tweetId": "1847362819999",
  "authorId": "1847100000001",
  "authorFollowerCount": 180,        // denormalised: fan-out must not call back to decide
  "body": "hello world",
  "mediaIds": []
}
```

`authorFollowerCount` rides along on purpose. Without it, the Fanout Worker would call
Graph just to decide which branch to take — an extra network round trip on the hottest path
in the system, for a number the producer already had.

**Partition keys are chosen for ordering, not balance.** Keying `tweet.created` by
`authorId` guarantees one author's create and delete arrive in order on the same partition.
Keying by `tweetId` would spread them and let a delete overtake its create.

### Consumers must be idempotent

Kafka delivers at least once. Every consumer therefore checks `eventId` against a
short-lived dedupe key before acting. A redelivered `tweet.created` that is not deduped puts
the same tweet in a timeline twice — a visible, embarrassing bug that only appears under the
retry conditions you cannot reproduce locally.

## A note on eventual consistency, for the client

The API is honest about a trade the architecture makes: **a successful `POST /v1/tweets`
does not mean the tweet is in anyone's timeline yet.** Convergence takes well under 5 s
(N3), but it is not zero.

Clients handle this by rendering the new tweet optimistically from the `201` response
rather than refetching the timeline — which would race the fan-out and show the user their
own tweet missing.

## See also

- [`01-system-design.md`](01-system-design.md) — the sequence diagrams these contracts implement
- [`03-data-model.md`](03-data-model.md) — what backs each field
- [`concepts/idempotent-consumers.md`](concepts/idempotent-consumers.md)
