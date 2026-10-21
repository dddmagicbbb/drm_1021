import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { ENV, type Env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    // 드라이버 어댑터는 URL의 schema 파라미터를 읽지 않으므로 직접 전달합니다.
    const schema = new URL(env.DATABASE_URL).searchParams.get("schema") ?? undefined;
    super({
      adapter: new PrismaPg(
        { connectionString: env.DATABASE_URL },
        schema ? { schema } : undefined,
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
