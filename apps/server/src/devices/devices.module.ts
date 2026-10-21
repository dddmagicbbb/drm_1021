import { Module } from "@nestjs/common";
import { DevicesController } from "./devices.controller.js";
import { DevicesService } from "./devices.service.js";

@Module({
  controllers: [DevicesController],
  providers: [DevicesService],
})
export class DevicesModule {}
