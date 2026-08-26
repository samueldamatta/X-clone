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
- Errors follow [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457).
- Every response carries `X-Request-Id`, propagated as the OpenTelemetry trace id.

## Public REST surface

### Identity

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/auth/register` | Create an account |
| `POST` | `/v1/auth/login` | Exchange credentials for an access + refresh token pair |
| `POST` | `/v1/auth/refresh` | Rotate the refresh token, issue a new access token |
| `POST` | `/v1/auth/logout` | Revoke the current session |
| `GET` | `/v1/users/{handle}` | Public profile |
| `PATCH` | `/v1/users/me` | Update own profile |

Access tokens are short-lived JWTs (15 min) verified at the Gateway without a network hop.
Refresh tokens are opaque, stored hashed, and **rotated on every use** — reuse of a spent
refresh token revokes the whole session chain, which is how you detect a stolen token.

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
  rpc GetUsers(UserIdList) returns (UserList);
  rpc VerifyToken(TokenRequest) returns (TokenClaims);
}
```

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
