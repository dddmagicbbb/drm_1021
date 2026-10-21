import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import {
  OtpRequestSchema,
  OtpVerifyRequestSchema,
  RefreshTokenRequestSchema,
  type OtpRequest,
  type OtpVerifyRequest,
  type RefreshTokenRequest,
  type TokenResponse,
} from "@drm/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { OtpService } from "./otp.service.js";
import { TokenService } from "./token.service.js";

@Controller("recipient-auth")
export class RecipientAuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
  ) {}

  /** 항상 202. 수신자 등록 여부를 노출하지 않습니다. */
  @Post("otp/request")
  @HttpCode(202)
  async requestOtp(@Body(new ZodValidationPipe(OtpRequestSchema)) body: OtpRequest): Promise<void> {
    await this.otp.request(body.email);
  }

  @Post("otp/verify")
  @HttpCode(200)
  verifyOtp(
    @Body(new ZodValidationPipe(OtpVerifyRequestSchema)) body: OtpVerifyRequest,
  ): Promise<TokenResponse> {
    return this.otp.verify(body.email, body.code);
  }

  @Post("refresh")
  @HttpCode(200)
  refresh(
    @Body(new ZodValidationPipe(RefreshTokenRequestSchema)) body: RefreshTokenRequest,
  ): Promise<TokenResponse> {
    return this.tokens.rotate(body.refreshToken, "RECIPIENT");
  }
}
