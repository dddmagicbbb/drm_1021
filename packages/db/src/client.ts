import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * Prisma 드라이버 어댑터 생성
 * 어댑터는 URL의 schema 파라미터를 읽지 않으므로 직접 전달합니다. (테스트 격리 스키마 등)
 */
export const createPgAdapter = (databaseUrl: string): PrismaPg => {
  const schema = new URL(databaseUrl).searchParams.get("schema") ?? undefined;
  return new PrismaPg({ connectionString: databaseUrl }, schema ? { schema } : undefined);
};

export const createPrismaClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
