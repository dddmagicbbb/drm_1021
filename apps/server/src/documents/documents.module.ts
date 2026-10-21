import { Module } from "@nestjs/common";
import { DocumentsController } from "./documents.controller.js";
import { DocumentsService } from "./documents.service.js";
import { BullPackagingQueue, PACKAGING_QUEUE_TOKEN } from "./packaging-queue.js";

@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService, { provide: PACKAGING_QUEUE_TOKEN, useClass: BullPackagingQueue }],
})
export class DocumentsModule {}
