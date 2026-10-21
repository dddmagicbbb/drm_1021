import { Controller, Get, Param, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { IdSchema, type RecipientDocument } from "@drm/contracts";
import type { Response } from "express";
import { CurrentSubject, RecipientGuard } from "../auth/auth.guard.js";
import type { AuthSubject } from "../auth/token.service.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RecipientDocumentsService } from "./recipient-documents.service.js";

/** RFC 6266/5987: 한글 파일명을 안전하게 전달 */
const contentDisposition = (fileName: string) => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

@Controller("recipient/documents")
@UseGuards(RecipientGuard)
export class RecipientDocumentsController {
  constructor(private readonly documents: RecipientDocumentsService) {}

  @Get()
  list(@CurrentSubject() recipient: AuthSubject): Promise<RecipientDocument[]> {
    return this.documents.list(recipient.id);
  }

  @Get(":docId/package")
  async download(
    @CurrentSubject() recipient: AuthSubject,
    @Param("docId", new ZodValidationPipe(IdSchema)) docId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const pkg = await this.documents.openPackage(recipient.id, docId);
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(pkg.size),
      "Content-Disposition": contentDisposition(pkg.fileName),
      "Cache-Control": "no-store",
    });
    return new StreamableFile(pkg.stream);
  }
}
