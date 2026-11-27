// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Static Symfony fallback: services from config/services.(yaml|yml|xml) and
 * event listeners from kernel.event_listener tags plus getSubscribedEvents().
 * Everything here is marked incomplete by the callers — no compiler passes run.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { childByType, nearestAncestor, nodeText, parsePhp, walkNodes } from '../php-parser';

export interface ServiceTag {
  name: string;
  attributes: Record<string, string>;
}

export interface StaticService {
  id: string;
  class?: string;
  public?: boolean;
  alias?: string;
  decorates?: string;
  tags: ServiceTag[];
  arguments: string[];
  file?: string;
}

export type ListenerSource = 'tag' | 'subscriber';

export interface StaticListener {
  event: string;
  service: string;
  class?: string;
  method: string;
  priority: number;
  source: ListenerSource;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeTags(raw: unknown): ServiceTag[] {
  const tags: ServiceTag[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        tags.push({ name: item, attributes: {} });
        continue;
      }
      if (!isPlainObject(item)) continue;
      const name = typeof item.name === 'string' ? item.name : '';
      if (!name) continue;
      const attributes: Record<string, string> = {};
      const source = isPlainObject(item.attributes) ? item.attributes : item;
      for (const [key, value] of Object.entries(source)) {
        if (key === 'name') continue;
        attributes[key] = compactValue(value);
      }
      tags.push({ name, attributes });
    }
    return tags;
  }

  if (isPlainObject(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const attributes: Record<string, string> = {};
          if (isPlainObject(item)) {
            for (const [key, entry] of Object.entries(item)) attributes[key] = compactValue(entry);
          }
          tags.push({ name, attributes });
        }
      } else if (isPlainObject(value)) {
        const attributes: Record<string, string> = {};
        for (const [key, entry] of Object.entries(value)) attributes[key] = compactValue(entry);
        tags.push({ name, attributes });
      } else {
        tags.push({ name, attributes: {} });
      }
    }
  }

  return tags;
}

function normalizeArguments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(compactValue);
}

function walkFiles(dir: string, pattern: RegExp, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, pattern, out);
    } else if (entry.isFile() && pattern.test(entry.name)) {
      out.push(full);
    }
  }
}

function serviceFiles(root: string): string[] {
  const files: string[] = [];
  const configDir = join(root, 'config');
  for (const name of ['services.yaml', 'services.yml', 'services.xml']) {
    const path = join(configDir, name);
    if (existsSync(path)) files.push(path);
  }
  const nested = join(configDir, 'services');
  if (existsSync(nested)) walkFiles(nested, /\.(ya?ml|xml)$/i, files);
  return files;
}

function parseYaml(text: string): unknown {
  const bun = Bun as unknown as { YAML?: { parse(input: string): unknown } };
  if (!bun.YAML?.parse) throw new Error('Bun.YAML is unavailable');
  return bun.YAML.parse(text);
}

function servicesFromYaml(text: string, file: string, root: string): StaticService[] {
  const doc = parseYaml(text) as { services?: unknown } | null;
  if (!isPlainObject(doc?.services)) return [];

  const services: StaticService[] = [];
  for (const [id, raw] of Object.entries(doc.services)) {
    if (id.startsWith('_')) continue;
    let def: PlainObject;
    if (typeof raw === 'string') def = { alias: raw };
    else if (isPlainObject(raw)) def = raw;
    else continue;

    // Resource prototypes (`App\: { resource: ../src/ }`) cannot be expanded statically.
    if (def.resource !== undefined) continue;

    services.push({
      id,
      class: typeof def.class === 'string' ? def.class : undefined,
      public: typeof def.public === 'boolean' ? def.public : undefined,
      alias: typeof def.alias === 'string' ? def.alias : undefined,
      decorates: typeof def.decorates === 'string' ? def.decorates : undefined,
      tags: normalizeTags(def.tags),
      arguments: normalizeArguments(def.arguments),
      file: relative(root, file),
    });
  }
  return services;
}

function parseXmlAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of text.matchAll(re)) {
    attributes[match[1]] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

function servicesFromXml(text: string, file: string, root: string): StaticService[] {
  const services: StaticService[] = [];
  const blocks: Array<{ attrs: string; body: string }> = [];

  const paired = /<service\b([^>]*?)>([\s\S]*?)<\/service>/g;
  for (const match of text.matchAll(paired)) blocks.push({ attrs: match[1], body: match[2] });
  const selfClosing = /<service\b([^>]*?)\/>/g;
  for (const match of text.matchAll(selfClosing)) blocks.push({ attrs: match[1], body: '' });

  for (const block of blocks) {
    const attributes = parseXmlAttributes(block.attrs);
    const id = attributes.id;
    if (!id || id.startsWith('_')) continue;

    const tags: ServiceTag[] = [];
    const tagRe = /<tag\b([^>]*?)\/?>/g;
    for (const match of block.body.matchAll(tagRe)) {
      const tagAttrs = parseXmlAttributes(match[1]);
      const name = tagAttrs.name;
      if (!name) continue;
      delete tagAttrs.name;
      tags.push({ name, attributes: tagAttrs });
    }

    const args: string[] = [];
    const argRe = /<argument\b[^>]*>([\s\S]*?)<\/argument>/g;
    for (const match of block.body.matchAll(argRe)) {
      args.push(match[1].replace(/<[^>]+>/g, '').trim());
    }
    const selfClosingArgRe = /<argument\b([^>]*?)\/>/g;
    for (const match of block.body.matchAll(selfClosingArgRe)) {
      const argAttrs = parseXmlAttributes(match[1]);
      if (argAttrs.type === 'service' && argAttrs.id) {
        args.push(`@${argAttrs.id}`);
      } else if (argAttrs.type === 'expression' && argAttrs.expression) {
        args.push(argAttrs.expression);
      } else if (argAttrs.id) {
        args.push(argAttrs.id);
      } else if (Object.keys(argAttrs).length > 0) {
        args.push(JSON.stringify(argAttrs));
      }
    }

    services.push({
      id,
      class: attributes.class,
      public: attributes.public === undefined ? undefined : attributes.public === 'true',
      alias: attributes.alias,
      decorates: attributes.decorates,
      tags,
      arguments: args,
      file: relative(root, file),
    });
  }
  return services;
}

/** Read config/services.* and expand the statically readable service definitions. */
export function readStaticServices(root: string): StaticService[] {
  const services: StaticService[] = [];
  for (const file of serviceFiles(root)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      services.push(
        ...(file.endsWith('.xml')
          ? servicesFromXml(text, file, root)
          : servicesFromYaml(text, file, root))
      );
    } catch {
      // A malformed file must not break the whole static lookup.
    }
  }
  return services;
}

function collectPhpFiles(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectPhpFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.php')) out.push(full);
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isQuoted(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  );
}

function isInteger(value: string): boolean {
  return /^-?\d+$/.test(value.trim());
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === quote && text[index - 1] !== '\\') quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '(' || char === '{') {
      depth++;
      current += char;
      continue;
    }
    if (char === ']' || char === ')' || char === '}') {
      depth--;
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseListenerValue(
  event: string,
  rawValue: string
): Array<{ event: string; method: string; priority: number }> {
  const value = rawValue.trim();
  if (isQuoted(value)) {
    return [{ event, method: stripQuotes(value), priority: 0 }];
  }
  if (!value.startsWith('[')) return [];

  const elements = splitTopLevel(value.slice(1, -1));
  if (!elements.some((element) => element.startsWith('['))) {
    const method = elements.find(isQuoted);
    const priority = elements.find(isInteger);
    return method
      ? [{ event, method: stripQuotes(method), priority: priority ? Number(priority) : 0 }]
      : [];
  }

  const listeners: Array<{ event: string; method: string; priority: number }> = [];
  for (const element of elements) {
    if (!element.startsWith('[')) continue;
    const parts = splitTopLevel(element.slice(1, -1));
    const method = parts.find(isQuoted);
    const priority = parts.find(isInteger);
    if (method) {
      listeners.push({
        event,
        method: stripQuotes(method),
        priority: priority ? Number(priority) : 0,
      });
    }
  }
  return listeners;
}

function findSubscribedArray(methodNode: Node): Node | null {
  let found: Node | null = null;
  walkNodes(methodNode, (node) => {
    if (!found && node.type === 'array_creation_expression') found = node;
  });
  return found;
}

/**
 * Parse `getSubscribedEvents()` with tree-sitter and extract event → method/priority.
 * Constant event keys (`Events::FOO`) are kept verbatim and unresolved.
 */
export async function parseSubscribedEvents(source: string): Promise<StaticListener[]> {
  const tree = await parsePhp(source);
  try {
    let methodNode: Node | null = null;
    walkNodes(tree.rootNode, (node) => {
      if (methodNode || node.type !== 'method_declaration') return;
      const name = childByType(node, 'name');
      if (name && nodeText(source, name) === 'getSubscribedEvents') methodNode = node;
    });
    if (!methodNode) return [];

    const classNode = nearestAncestor(
      methodNode,
      new Set(['class_declaration', 'trait_declaration', 'enum_declaration'])
    );
    const nameNode = classNode ? childByType(classNode, 'name') : null;
    const className = nameNode ? nodeText(source, nameNode) : null;
    const namespace = source.match(/^\s*namespace\s+([^;]+);/m)?.[1]?.trim();
    const fqcn = className ? (namespace ? `${namespace}\\${className}` : className) : undefined;

    const arrayNode = findSubscribedArray(methodNode);
    if (!arrayNode) return [];

    const arrayText = nodeText(source, arrayNode);
    if (!arrayText.startsWith('[')) return [];

    const listeners: StaticListener[] = [];
    for (const item of splitTopLevel(arrayText.slice(1, -1))) {
      const arrow = item.indexOf('=>');
      if (arrow < 0) continue;
      const event = stripQuotes(item.slice(0, arrow));
      const value = item.slice(arrow + 2);
      for (const parsed of parseListenerValue(event, value)) {
        listeners.push({
          event: parsed.event,
          service: fqcn ?? '(unknown subscriber)',
          class: fqcn,
          method: parsed.method,
          priority: parsed.priority,
          source: 'subscriber',
        });
      }
    }
    return listeners;
  } finally {
    tree.delete();
  }
}

/** Event listeners visible statically: service tags + getSubscribedEvents(). */
export async function collectStaticListeners(root: string): Promise<StaticListener[]> {
  const listeners: StaticListener[] = [];
  const services = readStaticServices(root);

  for (const service of services) {
    for (const tag of service.tags) {
      if (tag.name !== 'kernel.event_listener') continue;
      const event = tag.attributes.event;
      if (!event) continue;
      listeners.push({
        event,
        service: service.id,
        class: service.class,
        method: tag.attributes.method ?? '__invoke',
        priority: Number(tag.attributes.priority ?? 0) || 0,
        source: 'tag',
      });
    }
  }

  const phpFiles: string[] = [];
  collectPhpFiles(join(root, 'src'), phpFiles);
  for (const file of phpFiles) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('getSubscribedEvents')) continue;
    try {
      listeners.push(...(await parseSubscribedEvents(source)));
    } catch {
      // Unparsable PHP must not break the static event lookup.
    }
  }

  return listeners;
}
