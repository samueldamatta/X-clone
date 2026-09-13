import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { Profile as ProtoProfile } from '@x-clone/proto';
import { IdentityGrpcClient } from '../../infrastructure/identity/identity.grpc-client';
import type { VerifiedAccessToken } from '../../infrastructure/security/hs256-access-token-verifier';
import { AccessTokenGuard, Principal } from './access-token.guard';
import { parseUpdateProfileBody } from './update-profile.request';

/** Only the methods this controller calls — see auth.controller.ts for why. */
type IdentityClient = Pick<IdentityGrpcClient, 'getProfile' | 'updateProfile'>;

export interface PublicProfile {
  /**
   * A Snowflake, as a decimal string, and the reason this field exists
   * alongside `handle`: a handle can be renamed, this cannot. A client that
   * stores a reference to a person stores this one.
   */
  id: string;
  handle: string;
  displayName: string;
  /** '' for an account that never set one — never absent, never null. */
  bio: string;
  createdAt: string;
}

/**
 * The first route in this system that requires proof of identity, next to
 * the first one that deliberately does not.
 *
 * There is no try/catch: every failure reaching here is already a
 * ProblemDetailsException — from the guard, from parseUpdateProfileBody, or
 * from the gRPC client's own translation — and the global filter renders it.
 */
@Controller('v1/users')
export class UsersController {
  constructor(@Inject(IdentityGrpcClient) private readonly identity: IdentityClient) {}

  /**
   * Public: no guard, no token, nothing. A profile page is the one thing in
   * this system that exists to be seen by people who are not logged in, and
   * putting a guard here would mean a logged-out visitor cannot read the
   * page a link was shared to.
   *
   * Declared before the PATCH below, and that ordering is not load-bearing
   * in either direction: Nest matches on method *and* path, so `:handle` and
   * `me` never compete.
   */
  @Get(':handle')
  async profile(@Param('handle') handle: string): Promise<PublicProfile> {
    return toPublicProfile(await this.identity.getProfile({ handle }));
  }

  /**
   * `me`, not `:id`.
   *
   * The criterion is that an authenticated account cannot update anyone
   * else's profile. This route meets it by having nowhere to put another
   * account's id — the subject comes from `principal`, which comes from the
   * token the guard verified. There is no comparison to forget, because
   * there is no comparison.
   *
   * `me` is also safe against a collision with the public read above: a
   * handle must be 3-20 characters, so no account can ever be called `me`,
   * and `GET /v1/users/me` is a malformed handle rather than an ambiguity.
   *
   * 200 rather than 204: the response carries the profile as it now stands,
   * so a client does not have to guess what normalisation did to the value
   * it sent — a trimmed display name comes back trimmed.
   */
  @Patch('me')
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.OK)
  async updateOwnProfile(
    @Principal() principal: VerifiedAccessToken,
    @Body() body: unknown,
  ): Promise<PublicProfile> {
    const changes = parseUpdateProfileBody(body);

    const profile = await this.identity.updateProfile({
      // The only place the subject comes from. Not the body, not the path.
      userId: principal.userId,
      // Spread, so an omitted field stays omitted all the way to the wire.
      ...changes,
    });

    return toPublicProfile(profile);
  }
}

/**
 * Mapped field by field rather than returned as it arrived, like every
 * other response in this Gateway: the day the .proto grows a field, it must
 * not reach the public API because nobody remembered to strip it.
 */
function toPublicProfile(profile: ProtoProfile): PublicProfile {
  return {
    id: profile.id,
    handle: profile.handle,
    displayName: profile.displayName,
    bio: profile.bio,
    createdAt: profile.createdAt,
  };
}
