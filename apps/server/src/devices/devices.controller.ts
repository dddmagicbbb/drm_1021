import { Body, Controller, HttpStatus, Post, Res, UseGuards } from "@nestjs/common";
import {
  RegisterDeviceRequestSchema,
  type RegisterDeviceRequest,
  type RegisterDeviceResponse,
} from "@drm/contracts";
import type { Response } from "express";
import { CurrentSubject, RecipientGuard } from "../auth/auth.guard.js";
import type { AuthSubject } from "../auth/token.service.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { DevicesService } from "./devices.service.js";

@Controller("devices")
@UseGuards(RecipientGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** 신규 등록 201, 이미 등록된 같은 공개키는 200 (멱등) */
  @Post()
  async register(
    @CurrentSubject() subject: AuthSubject,
    @Body(new ZodValidationPipe(RegisterDeviceRequestSchema)) body: RegisterDeviceRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterDeviceResponse> {
    const result = await this.devices.register(subject.id, body);
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return { deviceId: result.deviceId };
  }
}
