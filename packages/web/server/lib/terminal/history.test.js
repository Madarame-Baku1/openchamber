import { describe, expect, it } from 'vitest';
import { sanitizeTerminalHistoryChunk } from './history.js';

describe('terminal replay history', () => {
  it('removes device and color query exchanges while preserving display controls', () => {
    const input = `before\u001b[6n\u001b[12;40R\u001b[>0c\u001b[?2031h\u001b[?2031$p\u001b[?2031;1$y\u001b]10;?\u0007\u001b[31mred\u001b[0mafter`;
    expect(sanitizeTerminalHistoryChunk('', input)).toEqual({ visible: 'before\u001b[31mred\u001b[0mafter', pending: '' });
  });

  it('carries incomplete control sequences across PTY chunks', () => {
    const first = sanitizeTerminalHistoryChunk('', 'text\u001b]11;');
    expect(first.visible).toBe('text');
    expect(first.pending).toMatchObject({ type: 'control-string', sequence: '\u001b]11;', overflow: false, osc: true });
    expect(sanitizeTerminalHistoryChunk(first.pending, '?\u001b\\next')).toEqual({ visible: 'next', pending: '' });
  });

  it('bounds and incrementally discards an unterminated OSC until its terminator', () => {
    let result = sanitizeTerminalHistoryChunk('', '\u001b]0;');
    for (let index = 0; index < 1024; index += 1) result = sanitizeTerminalHistoryChunk(result.pending, 'x'.repeat(4096));

    expect(result.visible).toBe('');
    expect(result.pending).toMatchObject({ type: 'control-string', overflow: true, sequence: '' });
    expect(result.pending.sequence.length).toBeLessThanOrEqual(4096);
    expect(sanitizeTerminalHistoryChunk(result.pending, '\u0007safe')).toEqual({ visible: 'safe', pending: '' });
  });

  it('discards a control string that crosses the cap in its terminating chunk', () => {
    const atLimit = sanitizeTerminalHistoryChunk('', '\u001b]0;' + 'x'.repeat(4092));

    expect(atLimit.pending.sequence).toHaveLength(4096);
    expect(sanitizeTerminalHistoryChunk(atLimit.pending, '\u0007')).toEqual({ visible: '', pending: '' });
    expect(sanitizeTerminalHistoryChunk(atLimit.pending, 'x\u0007safe')).toEqual({ visible: 'safe', pending: '' });

    const c1AtLimit = sanitizeTerminalHistoryChunk('', '\u009d0;' + 'x'.repeat(4093));
    expect(c1AtLimit.pending.sequence).toHaveLength(4096);
    expect(sanitizeTerminalHistoryChunk(c1AtLimit.pending, '\u009csafe')).toEqual({ visible: 'safe', pending: '' });
  });

  it('discards completed control strings that exceed the cap in one chunk', () => {
    const osc = sanitizeTerminalHistoryChunk('', '\u001b]0;' + 'x'.repeat(4092) + '\u0007safe');
    expect(osc).toEqual({ visible: 'safe', pending: '' });

    const c1String = sanitizeTerminalHistoryChunk('', '\u0090q' + 'x'.repeat(4094) + '\u009csafe');
    expect(c1String).toEqual({ visible: 'safe', pending: '' });
  });

  it('copies a short pending OSC suffix from a large PTY chunk', () => {
    const output = 'x'.repeat(8 * 1024 * 1024);
    const sequence = '\u001b]0;title😀\u001b';
    const result = sanitizeTerminalHistoryChunk('', output + sequence);

    expect(result.visible).toBe(output);
    expect(result.pending.sequence).toBe(sequence);
    expect(result.pending.sequence.length).toBeLessThanOrEqual(4096);
  });

  it('recognizes a string terminator split after ESC across an empty chunk', () => {
    const first = sanitizeTerminalHistoryChunk('', '\u001b]0;title\u001b');
    expect(first.pending).toMatchObject({ type: 'control-string', trailingEscape: true });
    const empty = sanitizeTerminalHistoryChunk(first.pending, '');
    expect(empty).toEqual({ visible: '', pending: first.pending });
    expect(sanitizeTerminalHistoryChunk(empty.pending, '\\after')).toEqual({ visible: '\u001b]0;title\u001b\\after', pending: '' });
  });

  it('preserves ordinary OSC titles and split UTF-16 text', () => {
    expect(sanitizeTerminalHistoryChunk('', '\u001b]0;title\u0007ok')).toEqual({ visible: '\u001b]0;title\u0007ok', pending: '' });
  });

  it('passes a clean chunk of ordinary text through unchanged', () => {
    const line = 'build result source/file.ts 0123456789\r\n';
    expect(sanitizeTerminalHistoryChunk('', line)).toEqual({ visible: line, pending: '' });
  });

  it('keeps ordinary runs between display controls in one piece', () => {
    const input = 'line1\r\n\u001b[1mbold\u001b[0m\r\nline2 tail';
    expect(sanitizeTerminalHistoryChunk('', input)).toEqual({ visible: input, pending: '' });
  });

  it('strips C1 device queries and keeps C1 string controls', () => {
    expect(sanitizeTerminalHistoryChunk('', 'a\u009b6nb')).toEqual({ visible: 'ab', pending: '' });
    expect(sanitizeTerminalHistoryChunk('', 'x\u009d10;?\u009cy\u009d0;title\u009cz')).toEqual({
      visible: 'xy\u009d0;title\u009cz',
      pending: '',
    });
  });

  it('keeps DCS and APC string controls in the replay text', () => {
    const input = 'a\u00901;2|data\u009cb\u001b[_apc\u0007c';
    expect(sanitizeTerminalHistoryChunk('', input)).toEqual({ visible: input, pending: '' });
  });
});
