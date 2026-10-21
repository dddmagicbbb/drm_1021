import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { SmtpMailer } from "../src/mail/mailer.js";

const mailpitApi = process.env.MAILPIT_API_URL;

/** 로컬(docker compose)·CI의 Mailpit으로 실제 SMTP 발송을 확인합니다. */
describe.runIf(mailpitApi)("SmtpMailer (Mailpit)", () => {
  it("SMTP로 메일을 발송한다", async () => {
    const mailer = new SmtpMailer(loadEnv({ NODE_ENV: "test" }));
    const to = `smtp-${randomUUID().slice(0, 8)}@customer.co.kr`;
    try {
      await mailer.send({ to, subject: "[DRM] 테스트", text: "본문 확인" });
    } finally {
      mailer.onModuleDestroy();
    }

    const res = await fetch(`${mailpitApi}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const body = (await res.json()) as { messages: { Subject: string }[] };
    expect(body.messages.map((m) => m.Subject)).toEqual(["[DRM] 테스트"]);
  });
});
