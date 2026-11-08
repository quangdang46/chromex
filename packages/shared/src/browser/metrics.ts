/**
 * CDP Performance.getMetrics result → compact name→value map.
 * Shared by both browser backends so browser.page.metrics reports the
 * same shape on chrome-extension and playwright-isolated.
 *
 * Values are numbers only — gauges are absolute, counters are
 * cumulative since Performance.enable. No page content is involved.
 */

export const METRICS_MAX_ENTRIES = 200;

export interface MetricsSummary {
  metrics: Record<string, number>;
  count: number;
  omitted?: number;
}

export function summarizeMetrics(result: unknown): MetricsSummary {
  const list = (result as { metrics?: unknown })?.metrics;
  const metrics: Record<string, number> = {};
  let count = 0;
  let omitted = 0;
  if (Array.isArray(list)) {
    for (const m of list) {
      const name = (m as { name?: unknown })?.name;
      const value = (m as { value?: unknown })?.value;
      if (typeof name !== "string" || typeof value !== "number" || !Number.isFinite(value)) continue;
      count += 1;
      if (Object.keys(metrics).length >= METRICS_MAX_ENTRIES) {
        omitted += 1;
        continue;
      }
      metrics[name] = value;
    }
  }
  return { metrics, count, ...(omitted > 0 ? { omitted } : {}) };
}
