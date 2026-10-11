import type { Logger } from "./logger.js";

export type Metrics = {
  increment(name: string, labels: Record<string, string>, value?: number): void;
  renderPrometheus(): string;
};

type Series = { name: string; labels: Record<string, string>; value: number };

export const noopMetrics: Metrics = {
  increment() {
    return undefined;
  },
  renderPrometheus() {
    return "";
  },
};

export function loggingMetrics(logger: Logger): Metrics {
  const series = new Map<string, Series>();
  return {
    increment(name, labels, value = 1) {
      const key = `${name}\n${labelKey(labels)}`;
      const current = series.get(key);
      if (current) current.value += value;
      else series.set(key, { name, labels: { ...labels }, value });
      logger.info("metric", {
        metric: name,
        ...labels,
        value,
      });
    },
    renderPrometheus() {
      const lines: string[] = [];
      const seen = new Set<string>();
      const rows = [...series.values()].sort((left, right) => {
        if (left.name !== right.name) return left.name < right.name ? -1 : 1;
        return labelKey(left.labels) < labelKey(right.labels) ? -1 : 1;
      });
      for (const row of rows) {
        if (!seen.has(row.name)) {
          lines.push(`# TYPE ${row.name} counter`);
          seen.add(row.name);
        }
        lines.push(`${row.name}${formatLabels(row.labels)} ${formatValue(row.value)}`);
      }
      return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    },
  };
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((key) => `${key}="${escapeLabel(labels[key] ?? "")}"`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function metricsAccess(input: {
  remoteAddress: string | undefined;
  metricsToken: string;
  authorization: string | undefined;
}): "ok" | "forbidden" | "unauthorized" {
  if (!input.metricsToken) {
    return isLoopbackAddress(input.remoteAddress) ? "ok" : "forbidden";
  }
  const header = input.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (match?.[1] === input.metricsToken) return "ok";
  return "unauthorized";
}
