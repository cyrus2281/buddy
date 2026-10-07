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

// ── Hands-off ────────────────────────────────────────────────────────────────

/// A hands-off run does not get the computer toolset at all. Every member of
/// it either moves the shared pointer, types into whatever has focus, or
/// photographs the whole display — the three things hands-off promises not to
/// do. What it gets instead acts on *named* elements of a *named* app, through
/// the accessibility tree (`sidecar/Sources/Hands.swift`).
///
/// Leaving the toolset in and refusing its members in the executor would have
/// been less code and a worse run: a model offered `left_click` reaches for it,
/// and every refusal is a wasted turn that teaches nothing.

export const LOOK_TOOL = 'look';
export const ACT_TOOL = 'act';
export const SET_VALUE_TOOL = 'set_value';
export const KEYS_TOOL = 'send_keys';
export const OPEN_TOOL = 'open';

export const HANDS_OFF_TOOLS = [LOOK_TOOL, ACT_TOOL, SET_VALUE_TOOL, KEYS_TOOL, OPEN_TOOL] as const;
export type HandsOffTool = (typeof HANDS_OFF_TOOLS)[number];

export const isHandsOffTool = (name: string): name is HandsOffTool =>
  (HANDS_OFF_TOOLS as readonly string[]).includes(name);

/** The verbs `act` accepts. `set_value` has its own tool because it carries
 *  text, and text is what the keystroke-content guardrail reads. */
export const ACT_VERBS = [
  'press',
  'focus',
  'select',
  'show_menu',
  'confirm',
  'cancel',
  'increment',
  'decrement',
  'scroll_to_visible',
  'raise',
] as const;

const ELEMENT_PROP = {
  type: 'string',
  description: 'An element id from the most recent `look`, e.g. "e42".',
} as const;

const APP_PROP = {
  type: 'string',
  description: 'The app’s bundle id, e.g. "com.tinyspeck.slackmacgap".',
} as const;

export function buildHandsOffTools(): Anthropic.Messages.ToolUnion[] {
  return [
    {
      name: LOOK_TOOL,
      description:
        'Look at one app’s window without bringing it to the front: a picture of the window and its ' +
        'accessibility tree, where every element has an id like e42. Works on a window that is behind ' +
        'others. Look before you act, and look again after anything that changes the window — ids from ' +
        'an older look stop resolving once the window changes.',
      input_schema: {
        type: 'object',
        properties: {
          app: APP_PROP,
          window_title: {
            type: 'string',
            description: 'Optional: part of the title of a specific window of that app.',
          },
        },
        required: ['app'],
      },
    },
    {
      name: ACT_TOOL,
      description:
        'Act on an element from the last look, through accessibility — the person’s pointer does not ' +
        'move and their app stays in front. "press" clicks a button, link, checkbox or menu item; ' +
        '"focus" puts the text cursor in a field (do this before send_keys); "select" picks a row, tab ' +
        'or option; "show_menu" opens a pop-up or context menu; "confirm"/"cancel" are a default ' +
        'button’s action; "increment"/"decrement" step a slider or stepper; "scroll_to_visible" ' +
        'brings an element into view; "raise" brings one of the app’s windows to the top of that app.',
      input_schema: {
        type: 'object',
        properties: {
          element: ELEMENT_PROP,
          action: { type: 'string', enum: [...ACT_VERBS] },
        },
        required: ['element', 'action'],
      },
    },
    {
      name: SET_VALUE_TOOL,
      description:
        'Replace the whole contents of a text field or text area with `text`, through accessibility. ' +
        'The result says whether the field now reads back what you set. Some web apps accept the ' +
        'value and ignore it; if it does not verify, focus the field and use send_keys instead.',
      input_schema: {
        type: 'object',
        properties: {
          element: ELEMENT_PROP,
          text: { type: 'string' },
        },
        required: ['element', 'text'],
      },
    },
    {
      name: KEYS_TOOL,
      description:
        'Send keystrokes to one app’s focused element, without bringing the app forward. Give exactly ' +
        'one of `key` — a shortcut like "cmd+k", "Return", "shift+Return", "Escape" — or `text` to type. ' +
        'Focus the field with act first. Return in a chat app sends the message. Native apps take these ' +
        'in the background; a web view (a browser, most Electron apps) usually ignores keys while its ' +
        'window is not in front — there, use set_value for text and act for buttons.',
      input_schema: {
        type: 'object',
        properties: {
          app: APP_PROP,
          key: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['app'],
      },
    },
    {
      name: OPEN_TOOL,
      description:
        'Launch an app, or open a URL or file in it, without bringing it to the front. Then look at it.',
      input_schema: {
        type: 'object',
        properties: {
          app: APP_PROP,
          url: { type: 'string', description: 'Optional: a URL, or an absolute file path.' },
        },
        required: ['app'],
      },
    },
    // `finish` is the same tool in both modes, and it stays last: the cache
    // breakpoint sits on it.
    buildTools().find((t) => 'name' in t && t.name === FINISH_TOOL)!,
  ];
}
