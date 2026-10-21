import { Controller, Get, HttpCode, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** 로드밸런서·모니터링용. DB 연결까지 확인합니다. */
  @Get()
  @HttpCode(200)
  async check(): Promise<{ status: "ok"; db: "ok" }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      throw new ServiceUnavailableException("데이터베이스에 연결할 수 없습니다.", { cause: error });
    }
    return { status: "ok", db: "ok" };
  }
}
