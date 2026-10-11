export type PolicyRequest = {
  tool: string;
  accountId: string;
  recipientDomains?: string[];
  bccDomains?: string[];
  documentId?: string;
};

export type PolicyDecision = { allowed: true } | { allowed: false; message: string };

export interface PolicyEngine {
  evaluate(request: PolicyRequest): PolicyDecision;
}

/** Test double. Production uses EnvAllowlistPolicy. */
export class AllowAllPolicy implements PolicyEngine {
  evaluate(): PolicyDecision {
    return { allowed: true };
  }
}
