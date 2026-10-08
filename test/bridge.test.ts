import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';
import { markViewForBridge, splitView } from '../src/cache.ts';
import { buildContext, carried } from '../src/transcript.ts';

const user = (content: UserMessage['content']): UserMessage => ({ role: 'user', content, timestamp: 1 });
const briefing = (text: string): AgentMessage => ({ role: 'custom', customType: 'memini-briefing', content: text, display: true, timestamp: 1 });
const recall = (text: string): AgentMessage => ({ role: 'custom', customType: 'memini-recall', content: text, display: true, timestamp: 1 });
const view = (lines: number) => `<chat>\n${Array.from({ length: lines }, (_, i) => `${i}+1|line ${i}`).join('\n')}\n</chat>`;
const marks = (message: AgentMessage) => message.role === 'user' && Array.isArray(message.content)
  ? message.content.flatMap((b, j) => 'cache_control' in b ? [[j, (b as { cache_control: unknown }).cache_control]] : []) : [];

test('the briefing a memory extension sends once per session reaches every run, right after the view', () => {
  const older = briefing('<memini-context>old</memini-context>'), latest = briefing('<memini-context>new</memini-context>');
  const current = user('What next?');
  const canonical = [older, user('earlier'), latest, current, recall('<memini-recall>r</memini-recall>')];
  const run = [current, canonical[4]];
  const carry = carried(canonical, run);
  assert.deepEqual(carry, [latest], 'only the latest briefing, and per-run recall is not carried');
  const context = buildContext(canonical, run, view(3), 'prompt', [], carry);
  assert.ok(context[1].role === 'user' && Array.isArray(context[1].content));
  assert.deepEqual(context[1].content.map(b => b.type === 'text' ? b.text : b.type), [view(3), '<memini-context>new</memini-context>', 'What next?']);
  assert.equal(context.at(-1), canonical[4], 'the run itself is unchanged');
  assert.deepEqual(carried(canonical, [current, briefing('sent again this run')]), [], 'a briefing already in the run is not repeated');
  assert.deepEqual(carried([current], [current]), []);
});

test('bridge turns mark the view once, 1h, on its last whole 4-line block', () => {
  const text = view(30);
  const context = markViewForBridge(buildContext([user('q')], [user('q')], text, 'prompt', [], [briefing('b')]));
  const first = context[1];
  assert.ok(first.role === 'user' && Array.isArray(first.content));
  const pieces = splitView(text);
  assert.equal(first.content.map(b => b.type === 'text' ? b.text : '').slice(0, pieces.length).join(''), text, 'the view is split, byte for byte');
  assert.deepEqual(marks(first), [[pieces.length - 2, { type: 'ephemeral', ttl: '1h' }]]);
  assert.deepEqual(first.content.slice(pieces.length).map(b => b.type === 'text' ? b.text : ''), ['b', 'q']);
  // The next turn's view grew at its end: every block up to the mark is unchanged, so the mark's prefix is a cache hit.
  const next = (markViewForBridge(buildContext([user('q2')], [user('q2')], view(37), 'prompt'))[1] as UserMessage).content as { text: string }[];
  assert.deepEqual(next.slice(0, pieces.length - 1).map(b => b.text), pieces.slice(0, -1));
  assert.equal(marks(context[0]).length + context.slice(2).flatMap(marks).length, 0, 'no other message is marked');
});

test('a view too short for a whole block, or no view, gets no mark', () => {
  assert.deepEqual(marks(markViewForBridge(buildContext([user('q')], [user('q')], view(2), 'prompt'))[1]), []);
  const plain = [user('no view here')];
  assert.deepEqual(markViewForBridge(plain), plain);
});
