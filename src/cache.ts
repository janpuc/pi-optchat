import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { isView } from './memory.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The view in blocks of 4 lines counted from its start (recipe §3.3), byte for byte. While the view only grows at its end,
 * every block but the last is the same in the next call. */
export function splitView(text: string) {
  const pieces: string[] = [];
  let offset = 0;
  for (let count = 0, at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1))
    if (++count % 4 === 0) { pieces.push(text.slice(offset, at + 1)); offset = at + 1; }
  pieces.push(text.slice(offset));
  return pieces;
}

/** How many blocks before the view's last whole one each mark sits. Anthropic looks back only 20 blocks from a mark for an
 * earlier entry, so the marks 20 and 40 blocks back still find the last call's entry after a turn of tool calls adds up to
 * 60 blocks (240 lines). With the end of the request, that is Anthropic's limit of 4 marks. */
const MARKS = [0, 20, 40];

/** Claude through pi-claude-bridge: Claude Code builds the request and places 3 of Anthropic's 4 marks itself (its system
 * prompt twice and the request's end, all 1h on a subscription), and sends a stored block's `cache_control` as is. So the
 * view is split into the same 4-line blocks with one mark, 1h like Claude Code's own (a 5m mark may not come before a 1h
 * one), on its last whole block. Needs a bridge that keeps marks on user text blocks (janpuc/pi-claude-bridge). */
export function markViewForBridge(messages: AgentMessage[]): AgentMessage[] {
  let done = false;
  return messages.map(message => {
    if (done || message.role !== 'user' || !Array.isArray(message.content)) return message;
    const at = message.content.findIndex(block => block.type === 'text' && isView(block.text));
    if (at < 0) return message;
    done = true;
    const view = message.content[at] as { text: string };
    const pieces = splitView(view.text);
    if (pieces.length < 2) return message;
    const blocks = pieces.map((text, j) => j === pieces.length - 2
      ? { type: 'text' as const, text, cache_control: { type: 'ephemeral', ttl: '1h' } }
      : { type: 'text' as const, text });
    return { ...message, content: [...message.content.slice(0, at), ...blocks, ...message.content.slice(at + 1)] } as AgentMessage;
  });
}

/** Anthropic: marks on the view (see MARKS) plus automatic end-of-request caching, so the next call finds the last one's entry
 * and pays only for the lines after it. */
export function cachePayload(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages;
  const view = new Set<unknown>();
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const at = message.content.findIndex((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string' && isView(block.text));
    if (at < 0) continue;
    const pieces = splitView(message.content[at].text), marked = new Set(MARKS.map(back => pieces.length - 2 - back));
    const blocks = pieces.map((text, j) => ({ type: 'text', text, ...(marked.has(j) ? { cache_control: { type: 'ephemeral' } } : {}) }));
    message.content.splice(at, 1, ...blocks);
    for (const block of blocks) view.add(block);
    break;
  }
  if (!view.size) return payload;
  // These marks only: Pi's own system, tool and recent-message marks are dropped.
  for (const section of [payload.system, payload.tools]) {
    if (Array.isArray(section)) for (const item of section) if (record(item)) delete item.cache_control;
  }
  for (const message of messages) {
    if (!record(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content)) for (const item of message.content) if (record(item) && !view.has(item)) delete item.cache_control;
  }
  payload.cache_control = { type: 'ephemeral' };
  return payload;
}
