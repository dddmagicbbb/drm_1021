import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import { ENV, type Env } from "../config/env.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** 메일 발송 추상화. 테스트에서는 메모리 구현으로 대체합니다. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol("MAILER");

@Injectable()
export class SmtpMailer implements Mailer, OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(ENV) env: Env) {
    this.from = env.MAIL_FROM;
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // 465는 암묵적 TLS, 그 외 포트는 서버가 지원하면 STARTTLS
      secure: env.SMTP_PORT === 465,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
