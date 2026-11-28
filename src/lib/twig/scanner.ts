// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Tolerant Twig tag scanner. Pure string work, no dependencies and no I/O:
 * malformed templates never throw, unknown tags are reported and scanning
 * continues. Line numbers are 1-based and CRLF-safe.
 */

export interface TwigTag {
  name: string;
  line: number;
}

export interface TwigBlock {
  name: string;
  line: number;
  parentCall: boolean;
}

export interface TwigReference {
  target: string;
  line: number;
}

export interface TwigScanResult {
  tags: TwigTag[];
  blocks: TwigBlock[];
  extends: TwigReference | null;
  uses: TwigReference[];
  embeds: TwigReference[];
  includes: TwigReference[];
  unknownTags: string[];
}

/** Builtin Twig tag names that are never reported as unknown. */
export const TWIG_KNOWN_TAGS: ReadonlySet<string> = new Set([
  'block',
  'endblock',
  'extends',
  'use',
  'embed',
  'endembed',
  'include',
  'set',
  'endset',
  'if',
  'elseif',
  'else',
  'endif',
  'for',
  'endfor',
  'macro',
  'endmacro',
  'import',
  'from',
  'filter',
  'endfilter',
  'apply',
  'endapply',
  'autoescape',
  'endautoescape',
  'spaceless',
  'endspaceless',
  'verbatim',
  'endverbatim',
  'sandbox',
  'endsandbox',
  'with',
  'endwith',
  'do',
  'flush',
  'deprecated',
]);

const PARENT_CALL = /\bparent\s*\(/;
const INCLUDE_CALL = /\binclude\s*\(\s*(['"])([^'"]*)\1/g;

interface TagEntry {
  name: string;
  line: number;
  /** Offset of the opening `{%`. */
  open: number;
  /** Offset just after the closing `%}` (or end of line for unterminated tags). */
  end: number;
  /** Raw text between `{%` and `%}`. */
  body: string;
}

interface PendingBlock {
  entry: TagEntry;
  name: string;
  parentCall: boolean;
}

function emptyResult(): TwigScanResult {
  return {
    tags: [],
    blocks: [],
    extends: null,
    uses: [],
    embeds: [],
    includes: [],
    unknownTags: [],
  };
}

function leadingTagName(body: string): string | null {
  const match = /^\s*[-~]?\s*([A-Za-z_]\w*)/.exec(body);
  return match ? match[1] : null;
}

function blockName(body: string): string | null {
  const match = /^\s*[-~]?\s*block\s+([A-Za-z_]\w*)/.exec(body);
  return match ? match[1] : null;
}

function quotedAfterDirective(body: string, directive: string): string | null {
  const re = new RegExp(`^\\s*[-~]?\\s*${directive}\\s+(['"])([\\s\\S]*?)\\1`);
  const match = re.exec(body);
  return match ? match[2] : null;
}

/** Find the closing `%}` of a `{%` tag, ignoring brackets inside quoted strings. */
function findTagEnd(source: string, start: number): number {
  let quote = '';
  for (let index = start + 2; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== '\\') quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '%' && source[index + 1] === '}') return index + 2;
  }
  return -1;
}

function maskRange(chars: string[], start: number, end: number): void {
  for (let index = start; index < end && index < chars.length; index++) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= offset) {
      if (mid === starts.length - 1 || starts[mid + 1] > offset) return mid + 1;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return 1;
}

function scan(source: string): TwigScanResult {
  const chars = source.split('');
  const starts = lineStarts(source);
  const entries: TagEntry[] = [];

  let index = 0;
  while (index < source.length) {
    // Comments: {# ... #} is masked but keeps its newlines for line numbers.
    if (source[index] === '{' && source[index + 1] === '#') {
      const commentEnd = source.indexOf('#}', index + 2);
      if (commentEnd === -1) {
        maskRange(chars, index, source.length);
        break;
      }
      maskRange(chars, index, commentEnd + 2);
      index = commentEnd + 2;
      continue;
    }

    if (source[index] === '{' && source[index + 1] === '%') {
      const tagEnd = findTagEnd(source, index);

      if (tagEnd === -1) {
        // Unterminated tag: take the rest of the line, then resume scanning.
        const newline = source.indexOf('\n', index);
        const end = newline === -1 ? source.length : newline;
        const body = source.slice(index + 2, end);
        const name = leadingTagName(body);
        if (name) entries.push({ name, line: lineAt(starts, index), open: index, end, body });
        index = end;
        continue;
      }

      const body = source.slice(index + 2, tagEnd - 2);
      const name = leadingTagName(body);

      if (name === 'verbatim') {
        if (name)
          entries.push({ name, line: lineAt(starts, index), open: index, end: tagEnd, body });
        const rest = source.slice(tagEnd);
        const closing = /{%[-~]?\s*endverbatim\s*[-~]?%}/.exec(rest);
        if (!closing) {
          maskRange(chars, tagEnd, source.length);
          break;
        }
        const closeStart = tagEnd + closing.index;
        maskRange(chars, tagEnd, closeStart);
        index = closeStart;
        continue;
      }

      if (name) entries.push({ name, line: lineAt(starts, index), open: index, end: tagEnd, body });
      index = tagEnd;
      continue;
    }

    index++;
  }

  const masked = chars.join('');
  const tags: TwigTag[] = [];
  const unknown = new Set<string>();
  const pending: PendingBlock[] = [];
  const stack: PendingBlock[] = [];
  const uses: TwigReference[] = [];
  const embeds: TwigReference[] = [];
  const includes: TwigReference[] = [];
  let extendsRef: TwigReference | null = null;

  for (const entry of entries) {
    tags.push({ name: entry.name, line: entry.line });

    if (!TWIG_KNOWN_TAGS.has(entry.name)) unknown.add(entry.name);

    if (entry.name === 'block') {
      const name = blockName(entry.body);
      if (name) {
        const block: PendingBlock = { entry, name, parentCall: false };
        pending.push(block);
        stack.push(block);
      }
      continue;
    }

    if (entry.name === 'endblock') {
      const block = stack.pop();
      if (block) block.parentCall = PARENT_CALL.test(masked.slice(block.entry.end, entry.open));
      continue;
    }

    if (entry.name === 'extends' && extendsRef === null) {
      const target = quotedAfterDirective(entry.body, 'extends');
      if (target) extendsRef = { target, line: entry.line };
      continue;
    }

    if (entry.name === 'use') {
      const target = quotedAfterDirective(entry.body, 'use');
      if (target) uses.push({ target, line: entry.line });
      continue;
    }

    if (entry.name === 'embed') {
      const target = quotedAfterDirective(entry.body, 'embed');
      if (target) embeds.push({ target, line: entry.line });
      continue;
    }

    if (entry.name === 'include') {
      const target = quotedAfterDirective(entry.body, 'include');
      if (target) includes.push({ target, line: entry.line });
    }
  }

  // Unclosed blocks run to the end of the file.
  for (const block of stack) block.parentCall = PARENT_CALL.test(masked.slice(block.entry.end));

  // include('...') function calls in expressions and text.
  for (const match of masked.matchAll(INCLUDE_CALL)) {
    const target = match[2];
    if (!target) continue;
    const offset = match.index ?? 0;
    includes.push({ target, line: lineAt(starts, offset) });
  }
  includes.sort((a, b) => a.line - b.line);

  return {
    tags,
    blocks: pending.map((block) => ({
      name: block.name,
      line: block.entry.line,
      parentCall: block.parentCall,
    })),
    extends: extendsRef,
    uses,
    embeds,
    includes,
    unknownTags: [...unknown],
  };
}

/** Scan Twig source. Never throws — malformed input yields a partial result. */
export function scanTwig(source: string): TwigScanResult {
  try {
    return scan(source);
  } catch {
    return emptyResult();
  }
}
