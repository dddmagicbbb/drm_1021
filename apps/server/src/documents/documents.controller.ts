import { Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { IdSchema, type Document } from "@drm/contracts";
import type { Request } from "express";
import { CurrentSubject, SenderGuard } from "../auth/auth.guard.js";
import type { AuthSubject } from "../auth/token.service.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { DocumentsService } from "./documents.service.js";

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** multipart/form-data, 필드명 `file`. 변환·암호화는 비동기로 진행되므로 202 */
  @Post("distributions/:id/documents")
  @HttpCode(202)
  @UseGuards(SenderGuard)
  upload(
    @CurrentSubject() sender: AuthSubject,
    @Param("id", new ZodValidationPipe(IdSchema)) distributionId: string,
    @Req() req: Request,
  ): Promise<Document> {
    return this.documents.upload(sender.id, distributionId, req);
  }
}
