import type {
  Distribution,
  DistributionState,
  DistributionSummary,
  Document,
  Policy,
} from "@drm/contracts";
import type {
  Distribution as DistributionRow,
  DistributionRecipient as MembershipRow,
  Document as DocumentRow,
  Recipient as RecipientRow,
} from "@drm/db";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const policyOf = (row: DistributionRow): Policy => ({
  validFrom: row.validFrom.toISOString(),
  validUntil: row.validUntil.toISOString(),
  allowWeb: row.allowWeb,
  securityLevel: row.securityLevel,
  offlineGraceHours: row.offlineGraceHours,
  maxViews: row.maxViews,
  maxDevices: row.maxDevices,
});

/** 표시용 상태 (저장 값이 아닌 서버 시각 기준 계산) */
export const stateOf = (row: DistributionRow, now = new Date()): DistributionState => {
  if (row.revokedAt) return "REVOKED";
  if (now < row.validFrom) return "SCHEDULED";
  if (now >= row.validUntil) return "EXPIRED";
  return "ACTIVE";
};

export const toDocument = (row: DocumentRow): Document => ({
  id: row.id,
  distributionId: row.distributionId,
  fileName: row.fileName,
  sourceFormat: row.sourceFormat,
  sourceSize: Number(row.sourceSize),
  status: row.status,
  failureReason: row.failureReason,
  revokedAt: iso(row.revokedAt),
  createdAt: row.createdAt.toISOString(),
});

type DistributionWithRelations = DistributionRow & {
  recipients: (MembershipRow & { recipient: RecipientRow })[];
  documents: DocumentRow[];
};

export const toDistribution = (row: DistributionWithRelations): Distribution => ({
  id: row.id,
  title: row.title,
  policy: policyOf(row),
  state: stateOf(row),
  recipients: row.recipients
    .slice()
    .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime())
    .map((m) => ({
      recipientId: m.recipientId,
      email: m.recipient.email,
      revokedAt: iso(m.revokedAt),
      addedAt: m.addedAt.toISOString(),
    })),
  documents: row.documents
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(toDocument),
  revokedAt: iso(row.revokedAt),
  createdBy: row.createdById,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toSummary = (
  row: DistributionRow & { _count: { recipients: number; documents: number } },
): DistributionSummary => ({
  id: row.id,
  title: row.title,
  policy: policyOf(row),
  state: stateOf(row),
  revokedAt: iso(row.revokedAt),
  createdBy: row.createdById,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  recipientCount: row._count.recipients,
  documentCount: row._count.documents,
});

/** Policy → DB 컬럼 */
export const policyColumns = (policy: Policy) => ({
  validFrom: new Date(policy.validFrom),
  validUntil: new Date(policy.validUntil),
  allowWeb: policy.allowWeb,
  securityLevel: policy.securityLevel,
  offlineGraceHours: policy.offlineGraceHours,
  maxViews: policy.maxViews,
  maxDevices: policy.maxDevices,
});
