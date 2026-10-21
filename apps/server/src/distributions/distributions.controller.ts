import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  CreateDistributionRequestSchema,
  IdSchema,
  UpdateDistributionRequestSchema,
  type CreateDistributionRequest,
  type Distribution,
  type DistributionSummary,
  type Document,
  type UpdateDistributionRequest,
} from "@drm/contracts";
import { z } from "zod";
import { CurrentSubject, SenderGuard } from "../auth/auth.guard.js";
import type { AuthSubject } from "../auth/token.service.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { DistributionsService } from "./distributions.service.js";

const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

const idPipe = new ZodValidationPipe(IdSchema);

@Controller()
@UseGuards(SenderGuard)
export class DistributionsController {
  constructor(private readonly distributions: DistributionsService) {}

  @Post("distributions")
  create(
    @CurrentSubject() sender: AuthSubject,
    @Body(new ZodValidationPipe(CreateDistributionRequestSchema)) body: CreateDistributionRequest,
  ): Promise<Distribution> {
    return this.distributions.create(sender.id, body);
  }

  @Get("distributions")
  list(
    @CurrentSubject() sender: AuthSubject,
    @Query(new ZodValidationPipe(PageQuerySchema)) query: z.infer<typeof PageQuerySchema>,
  ): Promise<DistributionSummary[]> {
    return this.distributions.list(sender.id, query.page, query.size);
  }

  @Get("distributions/:id")
  get(
    @CurrentSubject() sender: AuthSubject,
    @Param("id", idPipe) id: string,
  ): Promise<Distribution> {
    return this.distributions.get(sender.id, id);
  }

  @Patch("distributions/:id")
  update(
    @CurrentSubject() sender: AuthSubject,
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(UpdateDistributionRequestSchema)) body: UpdateDistributionRequest,
  ): Promise<Distribution> {
    return this.distributions.update(sender.id, id, body);
  }

  @Post("distributions/:id/revoke")
  @HttpCode(200)
  revoke(
    @CurrentSubject() sender: AuthSubject,
    @Param("id", idPipe) id: string,
  ): Promise<Distribution> {
    return this.distributions.revoke(sender.id, id);
  }

  @Post("distributions/:id/recipients/:recipientId/revoke")
  @HttpCode(200)
  revokeRecipient(
    @CurrentSubject() sender: AuthSubject,
    @Param("id", idPipe) id: string,
    @Param("recipientId", idPipe) recipientId: string,
  ): Promise<Distribution> {
    return this.distributions.revokeRecipient(sender.id, id, recipientId);
  }

  @Post("documents/:docId/revoke")
  @HttpCode(200)
  revokeDocument(
    @CurrentSubject() sender: AuthSubject,
    @Param("docId", idPipe) docId: string,
  ): Promise<Document> {
    return this.distributions.revokeDocument(sender.id, docId);
  }
}
