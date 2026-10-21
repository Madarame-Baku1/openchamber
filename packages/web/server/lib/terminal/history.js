const isCsiFinalByte = (code) => code >= 0x40 && code <= 0x7e;
const shouldStripCsi = (body, finalByte) =>
  finalByte === 'n'
  || (finalByte === 'R' && /^[0-9;?]*$/.test(body))
  || (finalByte === 'c' && /^[>0-9;?]*$/.test(body))
  || ((finalByte === 'p' || finalByte === 'y') && /^\?2031(?:;[0-9]+)?\$$/.test(body))
  || ((finalByte === 'h' || finalByte === 'l') && body === '?2031');
const shouldStripOsc = (content) => /^(10|11|12);(?:\?|rgb:)/.test(content);
const MAX_CONTROL_SEQUENCE_CODE_UNITS = 4096;
const isEscapeIntermediateByte = (code) => code >= 0x20 && code <= 0x2f;
const isEscapeFinalByte = (code) => code >= 0x30 && code <= 0x7e;
const findCsiEnd = (input, start) => {
  let cursor = start;
  while (cursor < input.length && !isCsiFinalByte(input.charCodeAt(cursor))) cursor += 1;
  return cursor < input.length ? cursor + 1 : null;
};
const scanEscapeSequence = (input, start) => {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) cursor += 1;
  if (cursor >= input.length) return { status: 'incomplete' };
  if (isEscapeFinalByte(input.charCodeAt(cursor))) return { status: 'complete', end: cursor + 1 };
  return { status: 'invalid', end: cursor };
};
const copyStringRange = (input, start, end) => {
  let copy = '';
  for (let cursor = start; cursor < end; cursor += 1024) {
    const length = Math.min(1024, end - cursor);
    const codeUnits = new Array(length);
    for (let index = 0; index < length; index += 1) codeUnits[index] = input.charCodeAt(cursor + index);
    copy += String.fromCharCode(...codeUnits);
  }
  return copy;
};
const stripTerminator = (value) => {
  if (value.endsWith('\u001b\\')) return value.slice(0, -2);
  return value.endsWith('\u0007') || value.endsWith('\u009c') ? value.slice(0, -1) : value;
};
const findStringEnd = (input, start) => {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return null;
};
// All six control-string introducers: ESC, DCS, CSI, OSC, PM, and APC. Replay
// history has to notice every one, or a C1 query byte leaks into the replay.
const isControlIntroducer = (code) => code === 0x1b || code === 0x90 || code === 0x9b || code === 0x9d || code === 0x9e || code === 0x9f;
const findControlIntroducer = (input, start) => {
  for (let cursor = start; cursor < input.length; cursor += 1) {
    if (isControlIntroducer(input.charCodeAt(cursor))) return cursor;
  }
  return -1;
};

export const sanitizeTerminalHistoryChunk = (pending, data) => {
  if (!data) return { visible: '', pending: pending ?? '' };
  if (pending?.type === 'discard-control-sequence') {
    let remainder;
    if (pending.kind === 'csi') {
      const end = findCsiEnd(data, 0);
      if (end === null) return { visible: '', pending };
      remainder = data.slice(end);
    } else {
      const sequence = scanEscapeSequence(data, 0);
      if (sequence.status === 'incomplete') return { visible: '', pending };
      remainder = data.slice(sequence.end);
    }
    return remainder ? sanitizeTerminalHistoryChunk('', remainder) : { visible: '', pending: '' };
  }
  if (pending?.type === 'control-string') {
    const end = pending.trailingEscape && data.startsWith('\\') ? 1 : findStringEnd(data, 0);
    if (end === null) {
      const combinedLength = pending.sequence.length + data.length;
      const overflow = pending.overflow || combinedLength > MAX_CONTROL_SEQUENCE_CODE_UNITS;
      const sequence = overflow ? '' : copyStringRange(`${pending.sequence}${data}`, 0, combinedLength);
      return {
        visible: '',
        pending: {
          type: 'control-string',
          sequence: overflow ? '' : sequence,
          overflow,
          osc: pending.osc,
          trailingEscape: data.endsWith('\u001b'),
        },
      };
    }

    const overflow = pending.overflow || pending.sequence.length + end > MAX_CONTROL_SEQUENCE_CODE_UNITS;
    const sequence = overflow ? '' : `${pending.sequence}${data.slice(0, end)}`;
    const contentStart = sequence.startsWith('\u001b') ? 2 : 1;
    const content = sequence ? stripTerminator(sequence.slice(contentStart)) : '';
    const completed = !overflow && (!pending.osc || !shouldStripOsc(content)) ? sequence : '';
    const remainder = data.slice(end);
    const rest = remainder ? sanitizeTerminalHistoryChunk('', remainder) : { visible: '', pending: '' };
    return { visible: completed + rest.visible, pending: rest.pending };
  }

  const input = `${pending ?? ''}${data}`;
  // With no carried state and no introducer anywhere, the chunk is ordinary
  // text and replay-safe as it stands; hand it back instead of rebuilding it.
  if (!pending && findControlIntroducer(input, 0) === -1) return { visible: input, pending: '' };
  let visible = '';
  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const next = input.charCodeAt(index + 1);
      if (Number.isNaN(next)) return { visible, pending: copyStringRange(input, index, input.length) };
      if (next === 0x5b) {
        const end = findCsiEnd(input, index + 2);
        if (end === null) {
          if (input.length - index > MAX_CONTROL_SEQUENCE_CODE_UNITS) {
            return { visible, pending: { type: 'discard-control-sequence', kind: 'csi' } };
          }
          return { visible, pending: copyStringRange(input, index, input.length) };
        }
        if (end - index <= MAX_CONTROL_SEQUENCE_CODE_UNITS
          && !shouldStripCsi(input.slice(index + 2, end - 1), input[end - 1])) {
          visible += input.slice(index, end);
        }
        index = end;
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
        const end = findStringEnd(input, index + 2);
        if (end === null) {
          const sequenceLength = input.length - index;
          const overflow = sequenceLength > MAX_CONTROL_SEQUENCE_CODE_UNITS;
          return {
            visible,
            pending: {
              type: 'control-string',
              sequence: overflow ? '' : copyStringRange(input, index, input.length),
              overflow,
              osc: next === 0x5d,
              trailingEscape: input.endsWith('\u001b'),
            },
          };
        }
        if (end - index <= MAX_CONTROL_SEQUENCE_CODE_UNITS) {
          const sequence = input.slice(index, end);
          const content = stripTerminator(input.slice(index + 2, end));
          if (next !== 0x5d || !shouldStripOsc(content)) visible += sequence;
        }
        index = end;
        continue;
      }
      const sequence = scanEscapeSequence(input, index + 1);
      if (sequence.status === 'incomplete') {
        if (input.length - index > MAX_CONTROL_SEQUENCE_CODE_UNITS) {
          return { visible, pending: { type: 'discard-control-sequence', kind: 'escape' } };
        }
        return { visible, pending: copyStringRange(input, index, input.length) };
      }
      if (sequence.status === 'invalid') {
        if (sequence.end - index > MAX_CONTROL_SEQUENCE_CODE_UNITS) {
          index = sequence.end;
          continue;
        }
        // Preserve the existing short malformed-escape handling.
        const end = Math.min(index + 2, input.length);
        visible += input.slice(index, end);
        index = end;
        continue;
      }
      if (sequence.end - index <= MAX_CONTROL_SEQUENCE_CODE_UNITS) visible += input.slice(index, sequence.end);
      index = sequence.end;
      continue;
    }
    if (code === 0x9b) {
      const end = findCsiEnd(input, index + 1);
      if (end === null) {
        if (input.length - index > MAX_CONTROL_SEQUENCE_CODE_UNITS) {
          return { visible, pending: { type: 'discard-control-sequence', kind: 'csi' } };
        }
        return { visible, pending: copyStringRange(input, index, input.length) };
      }
      if (end - index <= MAX_CONTROL_SEQUENCE_CODE_UNITS
        && !shouldStripCsi(input.slice(index + 1, end - 1), input[end - 1])) {
        visible += input.slice(index, end);
      }
      index = end;
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f) {
      const end = findStringEnd(input, index + 1);
      if (end === null) {
        const sequenceLength = input.length - index;
        const overflow = sequenceLength > MAX_CONTROL_SEQUENCE_CODE_UNITS;
        return {
          visible,
          pending: {
            type: 'control-string',
            sequence: overflow ? '' : copyStringRange(input, index, input.length),
            overflow,
            osc: code === 0x9d,
            trailingEscape: input.endsWith('\u001b'),
          },
        };
      }
      if (end - index <= MAX_CONTROL_SEQUENCE_CODE_UNITS) {
        const sequence = input.slice(index, end);
        const content = stripTerminator(input.slice(index + 1, end));
        if (code !== 0x9d || !shouldStripOsc(content)) visible += sequence;
      }
      index = end;
      continue;
    }
    // Ordinary text: copy the whole run up to the next introducer in one
    // slice instead of appending one character at a time.
    const runEnd = findControlIntroducer(input, index + 1);
    if (runEnd === -1) {
      visible += input.slice(index);
      break;
    }
    visible += input.slice(index, runEnd);
    index = runEnd;
  }
  return { visible, pending: '' };
};
