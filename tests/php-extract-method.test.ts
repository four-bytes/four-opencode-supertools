import { describe, it, expect } from 'bun:test';
import { resolve } from 'node:path';
import { extractMethod } from '../src/tools/extract-method';
import { parsePhpStrict } from '../src/lib/php-parser';

const fixture = (name: string): string => resolve(import.meta.dir, 'fixtures', 'php', name);

describe('extract_method', () => {
  it('inserts the new method inside the class after a multiline replacement (issue #78)', async () => {
    const result = await extractMethod({
      filePath: fixture('order-controller.php'),
      startLine: 10,
      endLine: 11,
      newMethodName: 'persistOrder',
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parameters).toEqual(['order']);

    const output = result.modifiedContent ?? '';
    // Valid PHP: the old implementation appended the method after the class brace.
    await parsePhpStrict(output, 'extract output');
    expect(output).toContain('$this->persistOrder($order);');
    expect(output).toContain('private function persistOrder(&$order): void');

    const newMethodAt = output.indexOf('private function persistOrder');
    const followingMethodAt = output.indexOf('private function assertPending');
    expect(newMethodAt).toBeGreaterThan(0);
    expect(newMethodAt).toBeLessThan(followingMethodAt);
    expect(output.trimEnd().endsWith('}')).toBe(true);
  });

  it('uses self:: and a static signature inside a static method', async () => {
    const result = await extractMethod({
      filePath: fixture('static-helper.php'),
      startLine: 7,
      endLine: 9,
      newMethodName: 'compute',
    });

    expect(result.success).toBe(true);
    const output = result.modifiedContent ?? '';
    await parsePhpStrict(output, 'extract output');
    expect(output).toContain('self::compute($a);');
    expect(output).toContain('private static function compute(&$a): void');
    expect(output).not.toContain('$this->compute');
  });

  it('passes parameters by reference so caller mutations survive extraction', async () => {
    const result = await extractMethod({
      filePath: fixture('mutating.php'),
      startLine: 7,
      endLine: 7,
      newMethodName: 'orderItems',
    });

    expect(result.success).toBe(true);
    const output = result.modifiedContent ?? '';
    await parsePhpStrict(output, 'extract output');
    expect(output).toContain('$this->orderItems($items);');
    expect(output).toContain('private function orderItems(&$items): void');
  });

  it('rejects by-reference output variables created inside the selection', async () => {
    const result = await extractMethod({
      filePath: fixture('mutating.php'),
      startLine: 8,
      endLine: 8,
      newMethodName: 'matchSubject',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('by-reference output');
    expect(result.error).toContain('$matches');
  });

  it('rejects a selection whose variable escapes into later code', async () => {
    const result = await extractMethod({
      filePath: fixture('static-helper.php'),
      startLine: 7,
      endLine: 8,
      newMethodName: 'compute',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('used after it');
    expect(result.error).toContain('$c');
  });

  it('rejects a selection containing return', async () => {
    const result = await extractMethod({
      filePath: fixture('order-controller.php'),
      startLine: 13,
      endLine: 13,
      newMethodName: 'getId',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('return_statement');
  });

  it('rejects a selection that includes non-statement lines', async () => {
    const result = await extractMethod({
      filePath: fixture('static-helper.php'),
      startLine: 6,
      endLine: 7,
      newMethodName: 'compute',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside complete statements');
  });

  it('rejects $this inside a static method', async () => {
    const result = await extractMethod({
      filePath: fixture('static-this.php'),
      startLine: 7,
      endLine: 7,
      newMethodName: 'callThing',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('$this');
    expect(result.error).toContain('static');
  });

  it('rejects break that would escape the extracted block', async () => {
    const result = await extractMethod({
      filePath: fixture('loop.php'),
      startLine: 9,
      endLine: 9,
      newMethodName: 'checkItem',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('break');
    expect(result.error).toContain('jump out');
  });

  it('rejects a selection that is not inside a method', async () => {
    const result = await extractMethod({
      filePath: fixture('order-controller.php'),
      startLine: 1,
      endLine: 3,
      newMethodName: 'nope',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not inside');
  });

  it('rejects invalid method names', async () => {
    const result = await extractMethod({
      filePath: fixture('order-controller.php'),
      startLine: 10,
      endLine: 11,
      newMethodName: '2invalid',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('valid PHP identifier');
  });
});
