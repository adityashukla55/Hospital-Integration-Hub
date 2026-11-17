/** Prometheus text exposition helpers (no client library needed for gauges/counters). */

export interface Sample {
  labels?: Record<string, string>;
  value: number;
}

export interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Sample[];
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export function render(metrics: Metric[]): string {
  const lines: string[] = [];
  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);
    for (const s of m.samples) {
      const labels = s.labels && Object.keys(s.labels).length
        ? '{' + Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',') + '}'
        : '';
      lines.push(`${m.name}${labels} ${Number.isFinite(s.value) ? s.value : 0}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Parses OIE's channel statistics XML (GET /api/channels/statistics). */
export function parseOieStatistics(xml: string, names: Map<string, string>): Metric {
  const samples: Sample[] = [];
  for (const block of xml.match(/<channelStatistics>[\s\S]*?<\/channelStatistics>/g) ?? []) {
    const id = /<channelId>([^<]+)<\/channelId>/.exec(block)?.[1] ?? '';
    const channel = names.get(id) ?? id;
    for (const kind of ['received', 'filtered', 'sent', 'error', 'queued']) {
      const v = new RegExp(`<${kind}>(\\d+)</${kind}>`).exec(block)?.[1];
      if (v !== undefined) samples.push({ labels: { channel, kind }, value: Number(v) });
    }
  }
  return { name: 'oie_channel_messages', help: 'OIE channel statistics (received, filtered, sent, error, queued) since the statistics were last reset', type: 'gauge', samples };
}
