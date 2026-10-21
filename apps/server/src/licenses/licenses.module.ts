import { Module } from "@nestjs/common";
import { LicensesController } from "./licenses.controller.js";
import { LicensesService } from "./licenses.service.js";

@Module({
  controllers: [LicensesController],
  providers: [LicensesService],
})
export class LicensesModule {}
