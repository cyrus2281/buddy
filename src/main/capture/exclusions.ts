import type { ExclusionRule, FrontmostSnapshot } from '../../shared/types.js';
import { log } from '../log.js';

/// The exclusion list (PRD §5.1). Three independent reasons a frame is never
/// taken, checked before the screenshot rather than after: there is no version
/// of a 1Password window we want written to disk and filtered later.

export type SkipReason = 'excluded-app' | 'excluded-title' | 'secure-input' | null;

export interface ExclusionCheck {
  skip: boolean;
  reason: SkipReason;
  rule: string | null;
}

/** Compiled once per settings change; a regex per frame per rule would be the
 *  most expensive thing on a loop that is otherwise nearly free. */
export class Exclusions {
  private bundleIds = new Map<string, string>();
  private titleRules: { re: RegExp; label: string }[] = [];

  constructor(rules: ExclusionRule[]) {
    this.update(rules);
  }

  update(rules: ExclusionRule[]) {
    this.bundleIds.clear();
    this.titleRules = [];
    for (const r of rules) {
      if (!r.enabled) continue;
      if (r.bundleId) this.bundleIds.set(r.bundleId.toLowerCase(), r.label);
      if (r.titlePattern) {
        try {
          this.titleRules.push({ re: new RegExp(r.titlePattern, 'i'), label: r.label });
        } catch (e) {
          // A user-authored regex that does not compile must not take the
          // capture loop down, but silently ignoring it would be worse than
          // saying so — they think that app is excluded.
          log.warn('exclusions', 'ignoring invalid title pattern', {
            label: r.label,
            pattern: r.titlePattern,
            error: (e as Error).message,
          });
        }
      }
    }
  }

  check(front: FrontmostSnapshot, focusedIsSecureField: boolean): ExclusionCheck {
    const byBundle = this.bundleIds.get(front.bundleId.toLowerCase());
    if (byBundle) return { skip: true, reason: 'excluded-app', rule: byBundle };

    for (const { re, label } of this.titleRules) {
      if (front.windowTitle && re.test(front.windowTitle)) {
        return { skip: true, reason: 'excluded-title', rule: label };
      }
    }

    // Two signals for the same thing. `secureInput` is the OS-wide flag some
    // other process raised; `focusedIsSecureField` is the AX tree reporting a
    // password field has focus. Either one means a password is being typed.
    if (front.secureInput) return { skip: true, reason: 'secure-input', rule: 'Secure Event Input held' };
    if (focusedIsSecureField) return { skip: true, reason: 'secure-input', rule: 'AXSecureTextField focused' };

    return { skip: false, reason: null, rule: null };
  }
}
