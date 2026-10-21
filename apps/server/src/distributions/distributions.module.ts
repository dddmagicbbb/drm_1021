import { Module } from "@nestjs/common";
import { DistributionsController } from "./distributions.controller.js";
import { DistributionsService } from "./distributions.service.js";

@Module({
  controllers: [DistributionsController],
  providers: [DistributionsService],
  exports: [DistributionsService],
})
export class DistributionsModule {}
