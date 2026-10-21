import { type DynamicModule, Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { correlationIdFor } from "./common/correlation-id.js";
import { ENV, type Env } from "./config/env.js";
import { HealthController } from "./health/health.controller.js";
import { PrismaModule } from "./prisma/prisma.module.js";

@Module({})
export class AppModule {
  /** 환경 변수를 주입받아 모듈을 구성합니다. 테스트에서 DB 등을 바꿔 끼우기 위함입니다. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            genReqId: correlationIdFor,
            // 인증 헤더·쿠키는 로그에 남기지 않습니다. (NFR-S7)
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              'res.headers["set-cookie"]',
            ],
            ...(env.NODE_ENV === "development"
              ? { transport: { target: "pino-pretty", options: { singleLine: true } } }
              : {}),
          },
        }),
        PrismaModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
