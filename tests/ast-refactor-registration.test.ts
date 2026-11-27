import { describe, it, expect } from 'bun:test';
import FourOpencodeSupertools from '../src/four-opencode-supertools';

const phpFixture = new URL('./fixtures/php/composer', import.meta.url).pathname;
const goFixture = new URL('./fixtures/go', import.meta.url).pathname;

describe('AST refactoring tool registration', () => {
  it('registers extract_method, rename_symbol and move_class for a PHP project', async () => {
    const plugin = await FourOpencodeSupertools({ directory: phpFixture } as never);
    const names = Object.keys(plugin.tool ?? {});
    expect(names).toContain('extract_method');
    expect(names).toContain('rename_symbol');
    expect(names).toContain('move_class');
    expect(names).toHaveLength(16);
  });

  it('advertises structural rename, not semantic cross-file resolution', async () => {
    const plugin = await FourOpencodeSupertools({ directory: phpFixture } as never);
    const rename = plugin.tool?.rename_symbol;
    expect(rename?.description).toContain('NOT semantic cross-file reference resolution');
    expect(rename?.description).toContain('ONE file');
  });

  it('does not register PHP refactoring tools for a Go project', async () => {
    const plugin = await FourOpencodeSupertools({ directory: goFixture } as never);
    const names = Object.keys(plugin.tool ?? {});
    expect(names).not.toContain('extract_method');
  });
});
