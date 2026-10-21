import { Module } from "@nestjs/common";
import { RecipientDocumentsController } from "./recipient-documents.controller.js";
import { RecipientDocumentsService } from "./recipient-documents.service.js";

@Module({
  controllers: [RecipientDocumentsController],
  providers: [RecipientDocumentsService],
})
export class RecipientModule {}
