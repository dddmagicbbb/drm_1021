/**
 * 발신자(사내 사용자) 계정 생성 CLI
 * 사용: pnpm --filter @drm/server sender:create -- --email hong@company.com --name 홍길동
 * 비밀번호는 표준 입력으로 받습니다. (명령줄 인자로 받으면 셸 기록에 남기 때문)
 */
import { EmailSchema } from "@drm/contracts";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { MIN_PASSWORD_LENGTH, hashPassword } from "../auth/password.js";
import { loadEnv } from "../config/env.js";
import { createPrismaClient } from "@drm/db";

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" } },
});
const email = EmailSchema.parse(values.email);
const name = values.name?.trim();
if (!name) throw new Error("--name 을 입력하세요");

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const password = (await rl.question(`비밀번호(${MIN_PASSWORD_LENGTH}자 이상): `)).trim();
rl.close();
if (password.length < MIN_PASSWORD_LENGTH) {
  throw new Error(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`);
}

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
try {
  const user = await prisma.user.create({
    data: { email, name, passwordHash: await hashPassword(password) },
  });
  console.log(`발신자 계정을 만들었습니다: ${user.email} (${user.id})`);
} finally {
  await prisma.$disconnect();
}
