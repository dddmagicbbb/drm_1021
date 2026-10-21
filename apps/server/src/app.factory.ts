import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import type { Env } from "./config/env.js";

export const API_PREFIX = "api/v1";

/** 공통 앱 설정. main과 통합 테스트가 같은 구성을 사용합니다. */
export const configureApp = (app: INestApplication): INestApplication => {
  const express = app as NestExpressApplication;
  express.useLogger(app.get(Logger));
  express.setGlobalPrefix(API_PREFIX);
  express.useGlobalFilters(new ApiExceptionFilter());
  express.disable("x-powered-by");
  // 리버스 프록시 뒤에서 실제 클라이언트 IP를 감사 로그에 남기기 위함 (프록시 1단계 신뢰)
  express.set("trust proxy", 1);
  express.enableShutdownHooks();
  return app;
};

export const createApp = async (env: Env): Promise<INestApplication> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    bufferLogs: true,
  });
  return configureApp(app);
};
