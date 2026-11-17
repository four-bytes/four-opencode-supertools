import { describe, it, expect } from 'bun:test';
import { resolve } from 'node:path';
import { moveClass } from '../src/tools/move-class';
import { parsePhpStrict } from '../src/lib/php-parser';

const fixture = (...parts: string[]): string =>
  resolve(import.meta.dir, 'fixtures', 'php', ...parts);

describe('move_class', () => {
  it('preserves declare(strict_types) and the imports the class actually uses (#78)', async () => {
    const result = await moveClass({
      sourcePath: fixture('move', 'service.php'),
      className: 'MovedService',
      targetPath: fixture('move', 'MovedService.php'),
      namespace: 'App\\Domain',
    });

    expect(result.success).toBe(true);
    const target = result.targetContent ?? '';
    const source = result.sourceContent ?? '';
    await parsePhpStrict(target, 'move target');
    await parsePhpStrict(source, 'move source');

    expect(target).toContain('declare(strict_types=1);');
    expect(target).toContain('namespace App\\Domain;');
    expect(target).toContain('use App\\Helper\\SomeHelper;');
    expect(target).not.toContain('use App\\Unused\\Thing;');
    expect(target).toContain('class MovedService');

    expect(source).not.toContain('class MovedService');
    expect(source).toContain('namespace App\\Service;');
  });

  it('keeps the docblock and attributes attached to the moved declaration', async () => {
    const result = await moveClass({
      sourcePath: fixture('move', 'documented.php'),
      className: 'DocumentedService',
      targetPath: fixture('move', 'DocumentedService.php'),
      namespace: 'App\\Docs\\Support',
    });

    expect(result.success).toBe(true);
    const target = result.targetContent ?? '';
    const source = result.sourceContent ?? '';
    await parsePhpStrict(target, 'move target');
    await parsePhpStrict(source, 'move source');
    expect(target).toContain('/**\n * Documented service.\n */');
    expect(target).toContain('#[SomeAttribute]');
    expect(target).toContain('use App\\Helper\\SomeHelper;');
    expect(source).not.toContain('Documented service.');
    expect(source).not.toContain('SomeAttribute');
  });

  it('does not inject strict_types when the source has no declare block (#78)', async () => {
    const result = await moveClass({
      sourcePath: fixture('move', 'no-declare.php'),
      className: 'LegacyHelper',
      targetPath: fixture('move', 'LegacyHelper.php'),
      namespace: 'App\\Legacy\\Support',
    });

    expect(result.success).toBe(true);
    const target = result.targetContent ?? '';
    await parsePhpStrict(target, 'move target');
    expect(target).not.toContain('declare(strict_types');
    expect(target).toContain('namespace App\\Legacy\\Support;');
    expect(target).toContain('class LegacyHelper');
  });

  it('derives the namespace from a Composer PSR-4 mapping', async () => {
    const composerSource = fixture('composer', 'src', 'Service', 'ComposedService.php');
    const composerTarget = fixture('composer', 'src', 'Domain', 'ComposedService.php');

    const result = await moveClass({
      sourcePath: composerSource,
      className: 'ComposedService',
      targetPath: composerTarget,
    });

    expect(result.success).toBe(true);
    const target = result.targetContent ?? '';
    await parsePhpStrict(target, 'move target');
    expect(target).toContain('namespace Acme\\Domain;');
    expect(result.warnings?.join(' ')).toContain('Composer PSR-4');
  });

  it('warns about unresolved same-namespace short names after the move', async () => {
    const result = await moveClass({
      sourcePath: fixture('move', 'same-namespace-ref.php'),
      className: 'Referencer',
      targetPath: fixture('move', 'Referencer.php'),
      namespace: 'App\\Target',
    });

    expect(result.success).toBe(true);
    expect(result.warnings?.join(' ')).toContain('Unresolved short names');
    expect(result.warnings?.join(' ')).toContain('Helper');
  });

  it('fails loudly when no namespace can be determined', async () => {
    const result = await moveClass({
      sourcePath: fixture('move', 'no-declare.php'),
      className: 'LegacyHelper',
      targetPath: fixture('move', 'LegacyHelper.php'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('namespace');
    expect(result.error).toContain('composer.json');
  });

  it('refuses to overwrite a non-empty target file', async () => {
    const result = await moveClass({
      sourcePath: fixture('move', 'no-declare.php'),
      className: 'LegacyHelper',
      targetPath: fixture('move', 'non-empty-target.php'),
      namespace: 'App\\Legacy\\Support',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('refusing to overwrite');
  });

  it('rejects an invalid explicit namespace', async () => {
    const result = await moveClass({
      sourcePath: fixture('move', 'no-declare.php'),
      className: 'LegacyHelper',
      targetPath: fixture('move', 'LegacyHelper.php'),
      namespace: '\\App\\Bad',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('backslash');
  });

  it('rejects a missing class', async () => {
    const result = await moveClass({
      sourcePath: fixture('move', 'no-declare.php'),
      className: 'Missing',
      targetPath: fixture('move', 'Missing.php'),
      namespace: 'App\\Legacy\\Support',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects syntactically invalid source', async () => {
    const result = await moveClass({
      sourcePath: fixture('broken.php'),
      className: 'Broken',
      targetPath: fixture('move', 'Broken.php'),
      namespace: 'App\\Broken',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('syntax error');
  });
});
