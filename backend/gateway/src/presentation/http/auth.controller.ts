import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { IdentityGrpcClient } from '../../infrastructure/identity/identity.grpc-client';
import { parseRegisterBody } from './register.request';

/**
 * Only the method this controller calls — see the test for why not the
 * concrete class. The DI token is still the class itself (below): an
 * interface has no runtime representation for Nest's reflection to find.
 */
type IdentityClient = Pick<IdentityGrpcClient, 'register'>;

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
}
