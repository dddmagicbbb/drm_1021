import type { Distribution, DistributionSummary, Document } from "@drm/contracts";
import { vi } from "vitest";
import { ApiClient } from "../api/client.js";

export const DIST_ID = "6f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b";
export const DOC_ID = "7a1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b";
export const RECIPIENT_ID = "8b1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b";
const SENDER_ID = "9c1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b";
const T = "2026-10-21T00:00:00.000Z";

export const sampleDocument = (patch: Partial<Document> = {}): Document => ({
  id: DOC_ID,
  distributionId: DIST_ID,
  fileName: "도면.pdf",
  sourceFormat: "PDF",
  sourceSize: 2048,
  status: "PACKAGED",
  failureReason: null,
  revokedAt: null,
  createdAt: T,
  ...patch,
});

export const sampleDistribution = (patch: Partial<Distribution> = {}): Distribution => ({
  id: DIST_ID,
  title: "A사 도면 송부",
  policy: {
    validFrom: T,
    validUntil: "2026-11-20T00:00:00.000Z",
    allowWeb: true,
    securityLevel: "NORMAL",
    offlineGraceHours: 0,
    maxViews: null,
    maxDevices: 2,
  },
  state: "ACTIVE",
  recipients: [
    { recipientId: RECIPIENT_ID, email: "kim@customer.co.kr", revokedAt: null, addedAt: T },
  ],
  documents: [sampleDocument()],
  revokedAt: null,
  createdBy: SENDER_ID,
  createdAt: T,
  updatedAt: T,
  ...patch,
});

export const sampleSummary = (): DistributionSummary => {
  const { recipients, documents, ...rest } = sampleDistribution();
  return { ...rest, recipientCount: recipients.length, documentCount: documents.length };
};

type Handler = (body: unknown, init: RequestInit) => { status: number; body?: unknown };

/** 경로별 응답을 지정하는 가짜 fetch */
export const fakeFetch = (routes: Record<string, Handler>) =>
  vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input).replace(/^\/api\/v1/, "");
    const key = `${init.method ?? "GET"} ${url}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({}), { status: 404 });
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const res = handler(body, init);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  });

export const TOKENS = { accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 };

/** 로그인된 상태의 클라이언트 */
export const loggedInClient = async (routes: Record<string, Handler>) => {
  const fetchMock = fakeFetch({
    "POST /auth/login": () => ({ status: 200, body: TOKENS }),
    ...routes,
  });
  const client = new ApiClient(fetchMock as unknown as typeof fetch, sessionStorage);
  await client.login("hong@company.com", "pw");
  return { client, fetchMock };
};
