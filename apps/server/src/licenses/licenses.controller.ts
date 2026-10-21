import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { LicenseRequestSchema, type LicenseRequest, type SignedLicense } from "@drm/contracts";
import { CurrentSubject, RecipientGuard } from "../auth/auth.guard.js";
import type { AuthSubject } from "../auth/token.service.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { LicensesService } from "./licenses.service.js";

@Controller("licenses")
@UseGuards(RecipientGuard)
export class LicensesController {
  constructor(private readonly licenses: LicensesService) {}

  @Post()
  @HttpCode(200)
  issue(
    @CurrentSubject() recipient: AuthSubject,
    @Body(new ZodValidationPipe(LicenseRequestSchema)) body: LicenseRequest,
  ): Promise<SignedLicense> {
    return this.licenses.issue(recipient.id, body);
  }
}
