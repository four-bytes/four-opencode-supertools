import { describe, it, expect } from 'bun:test';
import FourOpencodeSupertools from '../src/four-opencode-supertools';

describe('AST refactoring tool registration', () => {
  it('registers extract_method, rename_symbol and move_class', async () => {
    const plugin = await FourOpencodeSupertools({} as never);
    const names = Object.keys(plugin.tool ?? {});
    expect(names).toContain('extract_method');
    expect(names).toContain('rename_symbol');
    expect(names).toContain('move_class');
    expect(names).toHaveLength(16);
  });

  it('advertises structural rename, not semantic cross-file resolution', async () => {
    const plugin = await FourOpencodeSupertools({} as never);
    const rename = plugin.tool?.rename_symbol;
    expect(rename?.description).toContain('NOT semantic cross-file reference resolution');
    expect(rename?.description).toContain('ONE file');
  });
});
