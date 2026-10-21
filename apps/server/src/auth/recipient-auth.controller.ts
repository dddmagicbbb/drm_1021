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

  /**
   * 항상 즉시 202. 수신자 판정·메일 발송은 응답 이후 처리합니다.
   * (등록된 수신자일 때만 처리 시간이 길어지면 응답 시간으로 수신자 여부가 드러나기 때문)
   */
  @Post("otp/request")
  @HttpCode(202)
  requestOtp(@Body(new ZodValidationPipe(OtpRequestSchema)) body: OtpRequest): void {
    this.otp.requestInBackground(body.email);
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
