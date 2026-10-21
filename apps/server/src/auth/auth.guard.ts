import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { ApiException } from "../common/api-exception.js";
import type { SubjectType } from "../generated/prisma/enums.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { type AuthSubject, TokenService } from "./token.service.js";

type AuthedRequest = Request & { auth?: AuthSubject };

const bearerToken = (req: Request): string => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw ApiException.unauthenticated();
  return header.slice("Bearer ".length).trim();
};

abstract class SubjectGuard implements CanActivate {
  protected abstract readonly subjectType: SubjectType;

  constructor(protected readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const subject = await this.tokens.verifyAccessToken(bearerToken(req), this.subjectType);
    await this.assertActive(subject);
    req.auth = subject;
    return true;
  }

  protected async assertActive(_subject: AuthSubject): Promise<void> {}
}

/** 발신자 전용 API. 비활성화된 계정은 즉시 차단합니다. */
@Injectable()
export class SenderGuard extends SubjectGuard {
  protected readonly subjectType = "SENDER" as const;

  constructor(
    tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {
    super(tokens);
  }

  protected override async assertActive(subject: AuthSubject): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: subject.id },
      select: { disabledAt: true },
    });
    if (!user || user.disabledAt) throw ApiException.unauthenticated();
  }
}

/** 수신자 전용 API */
@Injectable()
export class RecipientGuard extends SubjectGuard {
  protected readonly subjectType = "RECIPIENT" as const;

  constructor(tokens: TokenService) {
    super(tokens);
  }
}

/** 가드가 검증한 인증 주체 */
export const CurrentSubject = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthSubject => {
    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) throw ApiException.unauthenticated();
    return auth;
  },
);
