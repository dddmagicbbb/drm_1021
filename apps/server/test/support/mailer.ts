import type { MailMessage, Mailer } from "../../src/mail/mailer.js";

/** 발송 메일을 메모리에 보관하는 테스트용 메일러 */
export class InMemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failNext = false;

  async send(message: MailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("SMTP 연결 실패 (테스트)");
    }
    this.sent.push(message);
  }

  /** 특정 수신자에게 마지막으로 보낸 메일 */
  lastTo(email: string): MailMessage | undefined {
    return this.sent.filter((m) => m.to === email).at(-1);
  }

  /** 마지막 OTP 메일에서 인증 코드 추출 */
  otpFor(email: string): string {
    const code = this.lastTo(email)?.text.match(/인증 코드: (\d{6})/)?.[1];
    if (!code) throw new Error(`${email}에게 보낸 OTP가 없습니다`);
    return code;
  }
}
