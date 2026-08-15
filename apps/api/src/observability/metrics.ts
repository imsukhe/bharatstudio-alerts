type CounterKey = `${string}|${string}|${number}`;

export type ApiMetrics = {
  observe(method: string, route: string, statusCode: number, durationMs: number): void;
  renderPrometheus(): string;
};

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export function createApiMetrics(): ApiMetrics {
  const counters = new Map<CounterKey, { count: number; durationMs: number }>();
  return {
    observe(method, route, statusCode, durationMs) {
      const key: CounterKey = `${method}|${route}|${statusCode}`;
      const current = counters.get(key) ?? { count: 0, durationMs: 0 };
      current.count += 1;
      current.durationMs += Math.max(0, durationMs);
      counters.set(key, current);
    },
    renderPrometheus() {
      const lines = [
        '# HELP bsa_api_requests_total API requests completed by normalized route.',
        '# TYPE bsa_api_requests_total counter',
        '# HELP bsa_api_request_duration_ms_sum API request duration sum in milliseconds.',
        '# TYPE bsa_api_request_duration_ms_sum counter',
      ];
      for (const [key, value] of [...counters.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const [method, route, statusCode] = key.split('|');
        const labels = `method="${escapeLabel(method ?? '')}",route="${escapeLabel(route ?? 'unknown')}",status_code="${escapeLabel(statusCode ?? '0')}"`;
        lines.push(`bsa_api_requests_total{${labels}} ${value.count}`);
        lines.push(`bsa_api_request_duration_ms_sum{${labels}} ${value.durationMs.toFixed(3)}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };
}
