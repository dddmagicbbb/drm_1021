import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import type { Env } from "./config/env.js";

export const API_PREFIX = "api/v1";

/** 애플리케이션 생성 (main과 통합 테스트가 같은 구성을 사용) */
export const createApp = async (env: Env): Promise<INestApplication> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.disable("x-powered-by");
  app.enableShutdownHooks();
  return app;
};
