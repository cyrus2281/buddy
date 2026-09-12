import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

/// The tool surface (PRD §6.3).
///
/// `computer_toolset_20260801` on `claude-opus-5`, **no beta header**. It is
/// schema-less — Claude carries the schema for all 17 members — so the entry
/// below carries only `type` and `cache_control`. There is no
/// `display_width_px` / `display_height_px` on this toolset: coordinates are in
/// the pixel space of the screenshot that was sent.
///
/// Plus two custom tools, which are where buddy beats a naive computer-use
/// agent.

export const COMPUTER_TOOLSET = 'computer_toolset_20260801' as const;

/** The toolset family name that must appear on every member's `tool_result`.
 *  Omitting it is a hard 400 that looks like a model failure (PRD §6.3). */
export const COMPUTER_TOOLSET_NAME = 'computer' as const;

/** The 17 members, as the vocabulary the executor and the guardrails agree on.
 *  Duplicated in `Input.swift`; both lists are short, fixed by the toolset
 *  version, and a mismatch fails loudly at the RPC boundary. */
export const COMPUTER_ACTIONS = [
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'cursor_position',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
] as const;

export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export const isComputerAction = (name: string): name is ComputerAction =>
  (COMPUTER_ACTIONS as readonly string[]).includes(name);

export const DESCRIBE_TOOL = 'describe_focused_window';
export const FINISH_TOOL = 'finish';

/** PRD §6.6. Parsed rather than trusted: the model picks the status and the
 *  wake terms, and a malformed `finish` must read as `needs_human` rather than
 *  as a silent success. */
export const FinishSchema = z.object({
  status: z.enum(['done', 'waiting', 'needs_human']),
  summary: z.string(),
  wake: z
    .object({
      after_s: z.number().int().min(1).max(86_400),
      condition: z.string(),
      max_attempts: z.number().int().min(1).max(200),
    })
    .optional(),
});

export type FinishInput = z.infer<typeof FinishSchema>;

/**
 * The tools array, in the order the cache prefix depends on.
 *
 * `cache_control` goes on the **last** entry so the whole tools block is one
 * cached prefix (PRD §6.5). Order must therefore stay stable across turns — any
 * reordering is a cache miss on every subsequent request.
 */
export function buildTools(): Anthropic.Messages.ToolUnion[] {
  return [
    { type: COMPUTER_TOOLSET },

    {
      name: DESCRIBE_TOOL,
      description:
        'Return the accessibility tree of the frontmost window: every element with its role, ' +
        'title, value, enabled state, and the screen coordinates of its centre. ' +
        'Call this together with a screenshot whenever you are about to click or type. ' +
        'Targeting a named element from this tree is far more reliable than estimating a pixel ' +
        'from the image, and it is the only way to be sure a control is enabled, or that the ' +
        'field you are about to type into is the one you think it is.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },

    {
      name: FINISH_TOOL,
      description:
        'End the run. Call this exactly once, as the last thing you do — do not end your turn ' +
        'with prose instead.\n' +
        '  status="done"        the goal is achieved.\n' +
        '  status="waiting"     you did everything possible and are blocked on something that ' +
        'will change on its own (a reply, a build, an approval). Supply `wake`.\n' +
        '  status="needs_human" you cannot proceed and a person must decide.\n' +
        'The summary is shown to the user as the run\'s outcome; say what you actually did, ' +
        'including anything you could not finish.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['done', 'waiting', 'needs_human'] },
          summary: { type: 'string', description: 'One or two sentences, in plain language.' },
          wake: {
            type: 'object',
            description: 'Required when status is "waiting"; omit otherwise.',
            properties: {
              after_s: { type: 'integer', description: 'Seconds until the first check.' },
              condition: {
                type: 'string',
                description:
                  'What must become true, stated so it can be judged from one screenshot. ' +
                  'e.g. "Priya has replied in #sam-eng".',
              },
              max_attempts: { type: 'integer', description: 'Give up and ask a human after this many checks.' },
            },
            required: ['after_s', 'condition', 'max_attempts'],
          },
        },
        required: ['status', 'summary'],
      },
      cache_control: { type: 'ephemeral' },
    },
  ];
}
