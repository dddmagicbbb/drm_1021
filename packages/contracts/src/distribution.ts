import { z } from "zod";
import { EmailSchema, IdSchema, IsoDateTimeSchema } from "./common.js";
import { DocumentSchema } from "./document.js";
import { PolicySchema } from "./policy.js";

/** 배포 건 1회에 등록 가능한 최대 수신자 수 */
export const MAX_RECIPIENTS_PER_DISTRIBUTION = 500;

const RecipientEmailsSchema = z
  .array(EmailSchema)
  .min(1)
  .max(MAX_RECIPIENTS_PER_DISTRIBUTION)
  .refine((list) => new Set(list).size === list.length, "중복된 수신자 이메일이 있습니다");

export const CreateDistributionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  recipients: RecipientEmailsSchema,
  policy: PolicySchema,
});
export type CreateDistributionRequest = z.infer<typeof CreateDistributionRequestSchema>;

/**
 * 배포 건 수정 (FR-106)
 * 기간·정책 변경과 수신자 추가·삭제는 재배포 없이 즉시 반영됩니다.
 */
export const UpdateDistributionRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    policy: PolicySchema.optional(),
    addRecipients: z.array(EmailSchema).max(MAX_RECIPIENTS_PER_DISTRIBUTION).optional(),
    removeRecipientIds: z.array(IdSchema).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), "변경할 항목이 없습니다");
export type UpdateDistributionRequest = z.infer<typeof UpdateDistributionRequestSchema>;

export const DistributionRecipientSchema = z.object({
  /** 수신자 내부 식별자. 이메일이 바뀌어도 유지됩니다. */
  recipientId: IdSchema,
  email: EmailSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  addedAt: IsoDateTimeSchema,
});
export type DistributionRecipient = z.infer<typeof DistributionRecipientSchema>;

/** 표시용 상태. 저장 값이 아니라 정책·회수 여부·서버 시각으로 계산합니다. */
export const DistributionStateSchema = z.enum(["SCHEDULED", "ACTIVE", "EXPIRED", "REVOKED"]);
export type DistributionState = z.infer<typeof DistributionStateSchema>;

export const DistributionSchema = z.object({
  id: IdSchema,
  title: z.string(),
  policy: PolicySchema,
  state: DistributionStateSchema,
  recipients: z.array(DistributionRecipientSchema),
  documents: z.array(DocumentSchema),
  revokedAt: IsoDateTimeSchema.nullable(),
  createdBy: IdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Distribution = z.infer<typeof DistributionSchema>;

export const DistributionSummarySchema = DistributionSchema.omit({
  recipients: true,
  documents: true,
}).extend({
  recipientCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
});
export type DistributionSummary = z.infer<typeof DistributionSummarySchema>;
