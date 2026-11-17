import { describe, it, expect } from 'bun:test';
import { resolve } from 'node:path';
import { renameSymbol } from '../src/tools/rename-symbol';
import { parsePhpStrict } from '../src/lib/php-parser';

const fixture = (name: string): string => resolve(import.meta.dir, 'fixtures', 'php', name);

describe('rename_symbol', () => {
  it('renames a property exactly once — no duplicate replacement corruption (#78)', async () => {
    const result = await renameSymbol({
      filePath: fixture('property.php'),
      oldName: 'name',
      newName: 'title',
    });

    expect(result.success).toBe(true);
    expect(result.replacementCount).toBe(2); // declaration + $this->name
    const output = result.modifiedContent ?? '';
    await parsePhpStrict(output, 'rename output');
    expect(output).toContain('private string $title');
    expect(output).toContain('return $this->title;');
    expect(output).not.toContain('titlee');
  });

  it('refuses an ambiguous method rename without a line target', async () => {
    const result = await renameSymbol({
      filePath: fixture('rename.php'),
      oldName: 'processOrder',
      newName: 'handleOrder',
      symbolKind: 'method',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ambiguous');
    expect(result.error).toContain('Pass line');
  });

  it('renames only the targeted declaration and same-class usage (#78)', async () => {
    const result = await renameSymbol({
      filePath: fixture('rename.php'),
      oldName: 'processOrder',
      newName: 'handleOrder',
      symbolKind: 'method',
      line: 9,
    });

    expect(result.success).toBe(true);
    expect(result.replacementCount).toBe(2); // First::processOrder + $this->processOrder()
    const output = result.modifiedContent ?? '';
    await parsePhpStrict(output, 'rename output');

    expect(output).toContain('public function handleOrder(): void');
    expect(output).toContain('$this->handleOrder();');
    // Second class and the free function must not be touched.
    const secondClass = output.slice(output.indexOf('class Second'));
    expect(secondClass).toContain('public function processOrder(): void');
    expect(secondClass).not.toContain('handleOrder');
    expect(output.slice(output.indexOf('function processOrder'))).toContain(
      'function processOrder(): void'
    );
  });

  it('does not rename same-name calls on other receivers or classes (#78)', async () => {
    const result = await renameSymbol({
      filePath: fixture('rename-receivers.php'),
      oldName: 'processOrder',
      newName: 'handleOrder',
      symbolKind: 'method',
    });

    expect(result.success).toBe(true);
    expect(result.replacementCount).toBe(2); // declaration + $this->processOrder()
    const output = result.modifiedContent ?? '';
    await parsePhpStrict(output, 'rename output');
    expect(output).toContain('$this->handleOrder();');
    expect(output).toContain('$other->processOrder();');
    expect(output).toContain('Other::processOrder();');
    expect(result.warnings?.join(' ')).toContain('same-name member access');
  });

  it('rejects file-wide variable renames without a line', async () => {
    const result = await renameSymbol({
      filePath: fixture('variables.php'),
      oldName: 'value',
      newName: 'total',
      symbolKind: 'variable',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires a line');
  });

  it('renames a variable only inside its scope', async () => {
    const result = await renameSymbol({
      filePath: fixture('variables.php'),
      oldName: '$value',
      newName: 'total',
      symbolKind: 'variable',
      line: 5,
    });

    expect(result.success).toBe(true);
    expect(result.replacementCount).toBe(2);
    const output = result.modifiedContent ?? '';
    await parsePhpStrict(output, 'rename output');
    const first = output.slice(0, output.indexOf('function second'));
    const second = output.slice(output.indexOf('function second'));
    expect(first).toContain('$total');
    expect(first).not.toContain('$value');
    expect(second).toContain('$value');
    expect(second).not.toContain('$total');
  });

  it('reports skipped usages when renameUsages is false instead of silently missing them', async () => {
    const result = await renameSymbol({
      filePath: fixture('property.php'),
      oldName: 'name',
      newName: 'title',
      symbolKind: 'property',
      renameUsages: false,
    });

    expect(result.success).toBe(true);
    expect(result.replacementCount).toBe(1);
    expect(result.modifiedContent).toContain('$this->name');
    expect(result.warnings?.join(' ')).toContain('renameUsages=false');
  });

  it('renames class references in types, new, static access and instanceof', async () => {
    const result = await renameSymbol({
      filePath: fixture('class-usage.php'),
      oldName: 'Widget',
      newName: 'Gadget',
      symbolKind: 'class',
    });

    expect(result.success).toBe(true);
    expect(result.replacementCount).toBeGreaterThanOrEqual(5);
    const output = result.modifiedContent ?? '';
    await parsePhpStrict(output, 'rename output');
    expect(output).toContain('class Gadget');
    expect(output).toContain('public function make(): Gadget');
    expect(output).toContain('new Gadget()');
    expect(output).toContain('Gadget::KIND');
    expect(output).toContain('$widget instanceof Gadget');
    expect(output).not.toMatch(/\bWidget\b/);
  });

  it('rejects invalid new identifiers', async () => {
    const result = await renameSymbol({
      filePath: fixture('property.php'),
      oldName: 'name',
      newName: '2bad',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('valid PHP identifier');
  });

  it('rejects syntactically invalid PHP instead of guessing', async () => {
    const result = await renameSymbol({
      filePath: fixture('broken.php'),
      oldName: 'Broken',
      newName: 'Fixed',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('syntax error');
  });
});
