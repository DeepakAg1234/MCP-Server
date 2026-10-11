import type { Metrics } from "../observability/metrics.js";
import { noopMetrics } from "../observability/metrics.js";
import type { LimitDecision, LimitRequest, RateLimiter } from "./rate-limiter.js";

const WINDOW_MS = 60_000;

export class InProcessRateLimiter implements RateLimiter {
  private readonly accountHits = new Map<string, number[]>();
  private readonly principalHits = new Map<string, number[]>();
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly limits: {
      perAccountPerMinute: number;
      perPrincipalPerMinute: number;
      maxConcurrencyPerAccount: number;
    },
    private readonly metrics: Metrics = noopMetrics,
    private readonly now: () => number = () => Date.now(),
  ) {}

  take(request: LimitRequest): LimitDecision {
    const now = this.now();
    const account = this.prune(this.accountHits, request.accountId, now);
    const principalKey = `${request.tenantId}:${request.userId}`;
    const principal = this.prune(this.principalHits, principalKey, now);
    if (account.length >= this.limits.perAccountPerMinute) {
      return this.reject(request.tool, account[0], now);
    }
    if (principal.length >= this.limits.perPrincipalPerMinute) {
      return this.reject(request.tool, principal[0], now);
    }
    const current = this.inflight.get(request.accountId) ?? 0;
    if (current >= this.limits.maxConcurrencyPerAccount) {
      this.metrics.increment("rate_limit_rejected_total", { tool: request.tool });
      return { allowed: false, retryAfterSeconds: 1 };
    }
    account.push(now);
    principal.push(now);
    this.accountHits.set(request.accountId, account);
    this.principalHits.set(principalKey, principal);
    this.inflight.set(request.accountId, current + 1);
    return { allowed: true };
  }

  release(request: LimitRequest): void {
    const current = this.inflight.get(request.accountId) ?? 0;
    if (current <= 1) this.inflight.delete(request.accountId);
    else this.inflight.set(request.accountId, current - 1);
  }

  private reject(tool: string, oldest: number | undefined, now: number): LimitDecision {
    this.metrics.increment("rate_limit_rejected_total", { tool });
    return { allowed: false, retryAfterSeconds: waitSeconds(oldest, now) };
  }

  private prune(store: Map<string, number[]>, key: string, now: number): number[] {
    const kept = (store.get(key) ?? []).filter((stamp) => now - stamp < WINDOW_MS);
    store.set(key, kept);
    return kept;
  }
}

function waitSeconds(oldest: number | undefined, now: number): number {
  if (oldest === undefined) return 1;
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}
