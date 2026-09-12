import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { IdentityGrpcClient } from '../../infrastructure/identity/identity.grpc-client';
import { parseLoginBody } from './login.request';
import { parseRegisterBody } from './register.request';

/**
 * Only the methods this controller calls — see the test for why not the
 * concrete class. The DI token is still the class itself (below): an
 * interface has no runtime representation for Nest's reflection to find.
 */
type IdentityClient = Pick<IdentityGrpcClient, 'register' | 'login'>;

export interface IssuedTokens {
  /**
   * A JWT. The client sends it as `Authorization: Bearer <accessToken>` on
   * every authenticated call — see docs/04-api-contracts.md.
   */
  accessToken: string;
  /** RFC 3339. When the access token stops being accepted. */
  accessTokenExpiresAt: string;
  /** Opaque, and good for exactly one thing: getting a new access token. */
  refreshToken: string;
  refreshTokenExpiresAt: string;
  /** Snowflake, as a decimal string. Who the caller just proved to be. */
  userId: string;
}

export interface RegisteredAccount {
  /**
   * A Snowflake, as a decimal string. Never a JSON number: 64 bits do not
   * survive JavaScript's 2^53-1, and the truncation is silent — see
   * docs/adr/0005-snowflake-ids.md.
   */
  id: string;
  handle: string;
  displayName: string;
  createdAt: string;
}

/**
 * The first public endpoint in this system. It parses, forwards, and maps
 * back — no rule of its own, which is what makes the Gateway thin.
 *
 * There is no try/catch: every failure reaching here is already a
 * ProblemDetailsException, either from parseRegisterBody or from the gRPC
 * client's own translation, and the global filter renders it.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(IdentityGrpcClient) private readonly identity: IdentityClient) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: unknown): Promise<RegisteredAccount> {
    const credentials = parseRegisterBody(body);
    const account = await this.identity.register(credentials);

    // Mapped field by field rather than returned as it arrived. The day the
    // .proto grows a field, it must not reach the public API because
    // nobody remembered to strip it.
    return {
      id: account.id,
      handle: account.handle,
      displayName: account.displayName,
      createdAt: account.createdAt,
    };
  }

  /**
   * 200, not 201. A session is created, but no URL now addresses it —
   * 201 promises a resource the client can go and GET, and there is none.
   *
   * The tokens come back in the response body. For a browser client an
   * httpOnly cookie would put the refresh token out of reach of XSS, which
   * is a real advantage this design gives up; the cost of taking it is a
   * cookie-shaped API that every non-browser client has to work around,
   * and CSRF protection to add on top. Worth revisiting when the frontend
   * arrives in Phase 5 and there is a real browser to decide for.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Headers('user-agent') userAgent?: string,
  ): Promise<IssuedTokens> {
    const credentials = parseLoginBody(body);

    const tokens = await this.identity.login({
      ...credentials,
      // proto3 has no null — Identity turns '' back into "no user agent".
      userAgent: userAgent ?? '',
    });

    // Field by field, like register: a field added to the .proto must not
    // become public because nobody remembered to strip it.
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      userId: tokens.userId,
    };
  }
}
