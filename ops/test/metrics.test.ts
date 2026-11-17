import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOieStatistics, render } from '../src/metrics.ts';

test('renders Prometheus text format with escaped labels', () => {
  const text = render([{ name: 'hub_messages', help: 'h', type: 'gauge', samples: [{ labels: { type: 'ADT^A01', status: 'say "hi"' }, value: 3 }, { value: NaN }] }]);
  assert.equal(text, '# HELP hub_messages h\n# TYPE hub_messages gauge\nhub_messages{type="ADT^A01",status="say \\"hi\\""} 3\nhub_messages 0\n');
});

test('parses OIE channel statistics XML', () => {
  const xml = `<list><channelStatistics><serverId>s</serverId><channelId>c1</channelId><received>10</received><sent>8</sent><error>1</error><filtered>0</filtered><queued>1</queued></channelStatistics></list>`;
  const m = parseOieStatistics(xml, new Map([['c1', 'Hub 1 - Inbound']]));
  assert.deepEqual(
    m.samples.map((s) => [s.labels!.kind, s.value]),
    [['received', 10], ['filtered', 0], ['sent', 8], ['error', 1], ['queued', 1]]
  );
  assert.equal(m.samples[0].labels!.channel, 'Hub 1 - Inbound');
});
