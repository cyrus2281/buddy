import { normalizeSpeech } from './match.js';

/// Which apps a spoken instruction names.
///
/// "Send a Slack message to Hugo" is a run that has to touch Slack, and the
/// allowlist a typed or spoken goal starts from is the Settings default —
/// which, out of the box, does not have Slack on it. Without this, the first
/// thing an attended run would do is stop and ask whether it may open the app
/// the person just named. So the app names in the instruction are added to the
/// list the HUD shows before the run starts; the person sees it, and Esc is
/// still the way out.
///
/// Matched against what is running (by the name macOS shows), then a short
/// list of the ways people say an app's name that is not its name.

const ALIASES: [RegExp, string][] = [
  [/\bslack\b/, 'com.tinyspeck.slackmacgap'],
  [/\b(imessage|text message|messages app)\b/, 'com.apple.MobileSMS'],
  [/\b(apple mail|mail app|an email|the email|email)\b/, 'com.apple.mail'],
  [/\bcalendar\b/, 'com.apple.iCal'],
  [/\bnotes\b/, 'com.apple.Notes'],
  [/\breminders?\b/, 'com.apple.reminders'],
  [/\bsafari\b/, 'com.apple.Safari'],
  [/\bchrome\b/, 'com.google.Chrome'],
  [/\bfinder\b/, 'com.apple.finder'],
  [/\b(vs code|vscode|visual studio code)\b/, 'com.microsoft.VSCode'],
  [/\bteams\b/, 'com.microsoft.teams2'],
  [/\bzoom\b/, 'us.zoom.xos'],
  [/\bnotion\b/, 'notion.id'],
];

export function appsMentioned(text: string, running: { bundleId: string; appName: string }[]): string[] {
  const said = ` ${normalizeSpeech(text)} `;
  const out = new Set<string>();
  for (const a of running) {
    const name = normalizeSpeech(a.appName);
    // A one- or two-letter app name ("X") would match half of English.
    if (a.bundleId && name.length >= 3 && said.includes(` ${name} `)) out.add(a.bundleId);
  }
  for (const [re, bundleId] of ALIASES) if (re.test(said)) out.add(bundleId);
  return [...out];
}
