// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolContext } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { CHECKSUM_ALGORITHM, checksumFromText, type Region } from '../lib/termlab/checksum';
import { parseSgrScreen, snapshotText, attributeRuns, type AttrRun } from '../lib/termlab/sgr';
import {
  isTmuxAvailable,
  KEY_PATTERN,
  TmuxSession,
  type MouseAction,
  type MouseButton,
  type TmuxRunner,
} from '../lib/termlab/tmux';

const TITLE = 'Term Run';
const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 40;
const DEFAULT_SETTLE_MS = 120;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_STEPS = 100;
const MAX_WAIT_MS = 5000;

const DESCRIPTION =
  'Drive a headless tmux session and capture the screen after each step. Steps send literal text, named keys or SGR mouse events, then wait and capture only changed rows. Optional per-step DECRQCRA checksum. Returns available:false when tmux is not installed.';

type TermRunContext = ToolContext & { tmuxRunner?: TmuxRunner; skipTmuxCheck?: boolean };

const MOUSE_ACTIONS: MouseAction[] = ['press', 'release', 'drag', 'move', 'wheel'];
const MOUSE_BUTTONS: MouseButton[] = ['left', 'middle', 'right', 'wheel-up', 'wheel-down'];

type StepAction = 'send' | 'key' | 'mouse' | 'wait';

interface MouseInput {
  action: MouseAction;
  x: number;
  y: number;
  button?: MouseButton;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

interface StepInput {
  send?: string;
  key?: string;
  mouse?: MouseInput;
  wait?: number;
  capture?: boolean;
}

interface ChangedRow {
  row: number;
  text: string;
  attrs?: AttrRun[];
}

interface StepOutput {
  index: number;
  action: StepAction;
  summary: string;
  changed: ChangedRow[];
  checksum?: { hex: string; cells: number; region: Region; algorithm: string };
}

class TimeoutError extends Error {}

function failure(error: string, hint: string, available = true) {
  return {
    title: TITLE,
    output: JSON.stringify({ available, error, hint }),
    metadata: { available, error: true },
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stepAction(step: StepInput): StepAction | null {
  const actions = [
    step.send !== undefined,
    step.key !== undefined,
    step.mouse !== undefined,
  ].filter((present) => present).length;
  if (actions > 1) return null;
  if (actions === 1) {
    if (step.send !== undefined) return 'send';
    if (step.key !== undefined) return 'key';
    return 'mouse';
  }
  if (step.wait !== undefined) return 'wait';
  return null;
}

function stepSummary(action: StepAction, step: StepInput): string {
  if (action === 'send') return `send ${JSON.stringify(step.send ?? '')}`;
  if (action === 'key') return `key ${step.key ?? ''}`;
  if (action === 'mouse') {
    const mouse = step.mouse as MouseInput;
    return `mouse ${mouse.action} ${mouse.button ?? 'left'} ${mouse.x},${mouse.y}`;
  }
  return step.wait === undefined ? 'wait' : `wait ${step.wait}ms`;
}

function validateMouse(mouse: MouseInput, width: number, height: number): string | null {
  if (!MOUSE_ACTIONS.includes(mouse.action)) return `unknown mouse action: ${mouse.action}`;
  if (mouse.button !== undefined && !MOUSE_BUTTONS.includes(mouse.button)) {
    return `unknown mouse button: ${mouse.button}`;
  }
  if (!Number.isInteger(mouse.x) || mouse.x < 0 || mouse.x >= width) {
    return `mouse x out of range: ${mouse.x}`;
  }
  if (!Number.isInteger(mouse.y) || mouse.y < 0 || mouse.y >= height) {
    return `mouse y out of range: ${mouse.y}`;
  }
  return null;
}

interface Snapshot {
  rows: string[];
  attrsFor?: (row: number) => AttrRun[];
}

async function captureSnapshot(session: TmuxSession, attributes: boolean): Promise<Snapshot> {
  const pane = await session.capture({ attributes });
  if (attributes) {
    const screen = parseSgrScreen(pane.raw, pane.width, pane.height);
    const rows = snapshotText(screen);
    return { rows, attrsFor: (row) => attributeRuns(screen, row) };
  }
  return { rows: pane.rows.map((row) => row.replace(/ +$/, '')) };
}

function rowSignature(text: string, attrs: AttrRun[] | undefined): string {
  return `${text}\u0000${JSON.stringify(attrs ?? [])}`;
}

function diffRows(
  previous: string[],
  previousSignatures: string[],
  current: Snapshot,
  full: boolean
): { changed: ChangedRow[]; signatures: string[] } {
  const changed: ChangedRow[] = [];
  const signatures: string[] = [];

  for (let row = 0; row < current.rows.length; row++) {
    const text = current.rows[row];
    const attrs = current.attrsFor ? current.attrsFor(row) : undefined;
    const signature = rowSignature(text, attrs);
    signatures.push(signature);

    if (!full && row < previous.length && previousSignatures[row] === signature) continue;

    const entry: ChangedRow = { row, text };
    if (attrs && attrs.length > 0) entry.attrs = attrs;
    changed.push(entry);
  }

  return { changed, signatures };
}

export const termRunTool = tool({
  description: DESCRIPTION,

  args: {
    command: tool.schema
      .union([tool.schema.string(), tool.schema.array(tool.schema.string())])
      .describe('Command to run in the session (string runs via the shell, array runs as argv).'),
    width: tool.schema.number().int().optional().default(DEFAULT_WIDTH).describe('Session width.'),
    height: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_HEIGHT)
      .describe('Session height.'),
    cwd: tool.schema.string().optional().describe('Working directory of the session.'),
    env: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .optional()
      .describe('Extra environment variables for the session.'),
    steps: tool.schema
      .array(
        tool.schema.object({
          send: tool.schema.string().optional().describe('Literal text to send.'),
          key: tool.schema.string().optional().describe('Named key, e.g. Enter, Tab, C-c.'),
          mouse: tool.schema
            .object({
              action: tool.schema.enum(MOUSE_ACTIONS),
              x: tool.schema.number().int().min(0),
              y: tool.schema.number().int().min(0),
              button: tool.schema.enum(MOUSE_BUTTONS).optional(),
              shift: tool.schema.boolean().optional(),
              alt: tool.schema.boolean().optional(),
              ctrl: tool.schema.boolean().optional(),
            })
            .optional(),
          wait: tool.schema.number().int().min(0).optional(),
          capture: tool.schema.boolean().optional(),
        })
      )
      .max(MAX_STEPS)
      .describe('Ordered interactions (max 100).'),
    settleMs: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_SETTLE_MS)
      .describe('Default wait after each step (clamped 0…5000).'),
    timeoutMs: tool.schema
      .number()
      .int()
      .optional()
      .default(DEFAULT_TIMEOUT_MS)
      .describe('Overall timeout (clamped 1000…300000).'),
    attributes: tool.schema
      .boolean()
      .optional()
      .default(true)
      .describe('Capture SGR attributes alongside changed text.'),
    full: tool.schema
      .boolean()
      .optional()
      .default(false)
      .describe('Return every row instead of only changed rows.'),
    checksum: tool.schema
      .boolean()
      .optional()
      .default(false)
      .describe('Include a per-step DECRQCRA-style checksum.'),
    region: tool.schema
      .object({
        x: tool.schema.number().int().min(0),
        y: tool.schema.number().int().min(0),
        width: tool.schema.number().int().min(1),
        height: tool.schema.number().int().min(1),
      })
      .optional()
      .describe('Checksum region (default: full screen).'),
    directory: tool.schema.string().optional().describe('Base directory used when cwd is omitted.'),
  },

  async execute(args, ctx) {
    const width = positiveInt(args.width, DEFAULT_WIDTH);
    const height = positiveInt(args.height, DEFAULT_HEIGHT);
    const settleMs = clamp(args.settleMs, 0, MAX_WAIT_MS, DEFAULT_SETTLE_MS);
    const timeoutMs = clamp(args.timeoutMs, 1000, 300000, DEFAULT_TIMEOUT_MS);
    const attributes = args.attributes !== false;
    const full = args.full === true;
    const withChecksum = args.checksum === true;

    if (!Array.isArray(args.steps)) {
      return failure('steps is required', 'Pass an array of steps (may be empty).');
    }
    if (args.steps.length > MAX_STEPS) {
      return failure(`too many steps (${args.steps.length})`, `Limit steps to ${MAX_STEPS}.`);
    }

    const steps = args.steps as StepInput[];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const action = stepAction(step);
      if (action === null) {
        return failure(
          `step ${index} must have exactly one action or a wait`,
          'Each step sets one of send/key/mouse, or only wait.'
        );
      }
      if (action === 'key' && !KEY_PATTERN.test(step.key ?? '')) {
        return failure(
          `step ${index}: invalid key name: ${step.key ?? ''}`,
          'Keys must match [A-Za-z0-9-]+ (e.g. Enter, Tab, C-c).'
        );
      }
      if (action === 'mouse') {
        const problem = validateMouse(step.mouse as MouseInput, width, height);
        if (problem) return failure(`step ${index}: ${problem}`, 'Keep coordinates in the pane.');
      }
    }

    const context = ctx as TermRunContext;
    const runner = context.tmuxRunner;
    const skipCheck = context.skipTmuxCheck === true;

    if (!skipCheck && !(await isTmuxAvailable(runner))) {
      return {
        title: TITLE,
        output: JSON.stringify({
          available: false,
          error: 'tmux not found',
          hint: 'Install tmux (Linux/WSL)',
        }),
        metadata: { available: false },
      };
    }

    const session = new TmuxSession({
      command: args.command,
      width,
      height,
      cwd: args.cwd ?? args.directory ?? ctx.directory,
      env: args.env,
      runner,
      timeoutMs,
    });

    const stepOutputs: StepOutput[] = [];
    let initial: { rows: string[] } | undefined;
    let timedOut = false;

    try {
      await session.start();

      const initialSnapshot = await captureSnapshot(session, attributes);
      initial = {
        rows: initialSnapshot.rows.map((row) => row.replace(/ +$/, '')).filter((row) => row !== ''),
      };

      let previousRows = initialSnapshot.rows;
      let previousSignatures = initialSnapshot.rows.map((row, index) =>
        rowSignature(row, initialSnapshot.attrsFor ? initialSnapshot.attrsFor(index) : undefined)
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      const loop = (async () => {
        for (let index = 0; index < steps.length; index++) {
          const step = steps[index];
          const action = stepAction(step) as StepAction;

          if (action === 'send') await session.sendLiteral(step.send ?? '');
          else if (action === 'key') await session.sendKey(step.key ?? '');
          else if (action === 'mouse') await session.sendMouse(step.mouse as MouseInput);

          const waitMs = clamp(step.wait ?? settleMs, 0, MAX_WAIT_MS, settleMs);
          if (waitMs > 0) await sleep(waitMs);

          const output: StepOutput = {
            index,
            action,
            summary: stepSummary(action, step),
            changed: [],
          };

          if (step.capture !== false) {
            const snapshot = await captureSnapshot(session, attributes);
            const { changed, signatures } = diffRows(
              previousRows,
              previousSignatures,
              snapshot,
              full
            );
            output.changed = changed;
            previousRows = snapshot.rows;
            previousSignatures = signatures;

            if (withChecksum) {
              const region = args.region ?? { x: 0, y: 0, width, height };
              const checksum = checksumFromText(snapshot.rows.join('\n'), region);
              output.checksum = {
                hex: checksum.hex,
                cells: checksum.cells,
                region: checksum.region,
                algorithm: CHECKSUM_ALGORITHM,
              };
            }
          }

          stepOutputs.push(output);
        }
      })();
      // Keep an eventual rejection (after a timeout) from surfacing as unhandled.
      loop.catch(() => {});

      try {
        await Promise.race([
          loop,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
          }),
        ]);
      } catch (err) {
        if (err instanceof TimeoutError) timedOut = true;
        else throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      if (timedOut) {
        logDebugEvent('term_run.timeout', { steps: stepOutputs.length, timeoutMs });
        return {
          title: TITLE,
          output: JSON.stringify({
            available: true,
            ok: false,
            error: 'timeout',
            steps: stepOutputs,
          }),
          metadata: { available: true, error: true, timeout: true, steps: stepOutputs.length },
        };
      }

      logDebugEvent('term_run.complete', {
        steps: stepOutputs.length,
        changedRows: stepOutputs.reduce((sum, step) => sum + step.changed.length, 0),
        width,
        height,
      });

      return {
        title: TITLE,
        output: JSON.stringify({
          ok: true,
          width,
          height,
          tmux: true,
          steps: stepOutputs,
          initial: initial ?? { rows: [] },
        }),
        metadata: { steps: stepOutputs.length, width, height },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDebugEvent('term_run.error', { message, steps: stepOutputs.length });
      return {
        title: TITLE,
        output: JSON.stringify({
          available: true,
          ok: false,
          error: message,
          steps: stepOutputs,
        }),
        metadata: { available: true, error: true, steps: stepOutputs.length },
      };
    } finally {
      await session.kill();
    }
  },
});
