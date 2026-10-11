export type LimitRequest = {
  tool: string;
  accountId: string;
  tenantId: string;
  userId: string;
};

export type LimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  take(request: LimitRequest): LimitDecision;
  release(request: LimitRequest): void;
}

/** Test double. Production uses InProcessRateLimiter. */
export class AllowAllRateLimiter implements RateLimiter {
  take(): LimitDecision {
    return { allowed: true };
  }

  release(): void {
    return undefined;
  }
}
