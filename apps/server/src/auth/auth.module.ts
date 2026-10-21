import { Global, Module } from "@nestjs/common";
import { RecipientGuard, SenderGuard } from "./auth.guard.js";
import { OtpService } from "./otp.service.js";
import { RecipientAuthController } from "./recipient-auth.controller.js";
import { SenderAuthController } from "./sender-auth.controller.js";
import { SenderAuthService } from "./sender-auth.service.js";
import { TokenService } from "./token.service.js";

@Global()
@Module({
  controllers: [SenderAuthController, RecipientAuthController],
  providers: [TokenService, SenderAuthService, OtpService, SenderGuard, RecipientGuard],
  exports: [TokenService, SenderGuard, RecipientGuard],
})
export class AuthModule {}
