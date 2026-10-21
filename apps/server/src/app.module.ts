import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { AuditModule } from "./audit/audit.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { correlationIdFor } from "./common/correlation-id.js";
import { RequestContextMiddleware } from "./common/request-context.js";
import { ENV, type Env } from "./config/env.js";
import { DevicesModule } from "./devices/devices.module.js";
import { DistributionsModule } from "./distributions/distributions.module.js";
import { DocumentsModule } from "./documents/documents.module.js";
import { HealthController } from "./health/health.controller.js";
import { KeysModule } from "./keys/keys.module.js";
import { LicensesModule } from "./licenses/licenses.module.js";
import { MailModule } from "./mail/mail.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RecipientModule } from "./recipient/recipient.module.js";
import { StorageModule } from "./storage/storage.module.js";

@Module({})
export class AppModule implements NestModule {
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
        AuditModule,
        KeysModule,
        StorageModule,
        MailModule,
        AuthModule,
        DevicesModule,
        DistributionsModule,
        LicensesModule,
        DocumentsModule,
        RecipientModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*path");
  }
}
