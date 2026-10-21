import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import {
  RefreshTokenRequestSchema,
  SenderLoginRequestSchema,
  type RefreshTokenRequest,
  type SenderLoginRequest,
  type TokenResponse,
} from "@drm/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { SenderAuthService } from "./sender-auth.service.js";
import { TokenService } from "./token.service.js";

@Controller("auth")
export class SenderAuthController {
  constructor(
    private readonly auth: SenderAuthService,
    private readonly tokens: TokenService,
  ) {}

  @Post("login")
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(SenderLoginRequestSchema)) body: SenderLoginRequest,
  ): Promise<TokenResponse> {
    return this.auth.login(body);
  }

  @Post("refresh")
  @HttpCode(200)
  refresh(
    @Body(new ZodValidationPipe(RefreshTokenRequestSchema)) body: RefreshTokenRequest,
  ): Promise<TokenResponse> {
    return this.tokens.rotate(body.refreshToken, "SENDER");
  }
}
