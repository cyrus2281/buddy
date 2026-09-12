import { page, esc } from './chrome.js';

/// App mockups for the recorded fixture scenes. One function per app, each
/// taking only what the scene varies, so the fifteen frames differ in content
/// rather than in fifteen separately-drifting layouts.

const SLACK_CSS = `
  .slack { display: flex; height: 100%; background: #1a1d21; color: #d1d2d3; }
  .ws { width: 68px; background: #3f0e40; padding: 12px 0; display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .ws .tile { width: 38px; height: 38px; border-radius: 10px; background: #6b2d6c; color: #fff;
              display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; }
  .ws .ico { width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center;
             justify-content: center; color: #cfa9cf; font-size: 17px; }
  .chans { width: 246px; background: #19171d; padding: 10px 0; font-size: 14px; }
  .chans h2 { color: #fff; font-size: 16px; padding: 6px 16px 12px; font-weight: 700; }
  .chans .sec { color: #9a9b9e; padding: 10px 16px 4px; font-size: 12.5px; }
  .chans .row { padding: 4px 16px; color: #bcabbc; }
  .chans .row.on { background: #1164a3; color: #fff; border-radius: 0; }
  .chans .row.unread { color: #fff; font-weight: 700; }
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .chead { height: 50px; border-bottom: 1px solid #35373b; display: flex; align-items: center;
           padding: 0 20px; gap: 10px; }
  .chead .name { color: #fff; font-weight: 700; font-size: 16px; }
  .chead .meta { color: #9a9b9e; font-size: 13px; }
  .msgs { flex: 1; overflow: hidden; padding: 14px 20px; }
  .msg { display: flex; gap: 10px; padding: 7px 0; }
  .av { width: 36px; height: 36px; border-radius: 5px; flex: none; color: #fff;
        display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; }
  .msg .who { color: #fff; font-weight: 700; font-size: 15px; }
  .msg .t { color: #9a9b9e; font-size: 12px; margin-left: 7px; }
  .msg .txt { font-size: 15px; line-height: 1.48; margin-top: 2px; max-width: 900px; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 12px 0; }
  .divider .line { flex: 1; height: 1px; background: #e01e5a; }
  .divider .lbl { color: #e01e5a; font-size: 12px; font-weight: 700; }
  .compose { margin: 0 20px 18px; border: 1px solid #565856; border-radius: 8px;
             padding: 11px 13px; color: #6f7276; font-size: 15px; }
`;

export interface SlackMessage {
  who: string;
  initials: string;
  color: string;
  time: string;
  text: string;
  unreadBefore?: boolean;
}

export function slack(opts: {
  channel: string;
  members?: string;
  messages: SlackMessage[];
  activeChannel?: string;
  clock: string;
  dmMode?: boolean;
}): string {
  const channels = ['general', 'sam-eng', 'sam-releases', 'design', 'random'];
  const active = opts.activeChannel ?? 'sam-eng';
  return page({
    app: 'Slack',
    menus: ['File', 'Edit', 'View', 'Go', 'Window', 'Help'],
    clock: opts.clock,
    bg: '#1a1d21',
    css: SLACK_CSS,
    body: `<div class="slack">
      <div class="ws">
        <div class="tile">S</div>
        <div class="ico">&#9737;</div><div class="ico">&#9993;</div><div class="ico">&#128172;</div>
      </div>
      <div class="chans">
        <h2>Solace</h2>
        <div class="sec">&#9662; Channels</div>
        ${channels
          .map(
            (c) =>
              `<div class="row ${c === active && !opts.dmMode ? 'on' : ''}"># ${c}</div>`,
          )
          .join('')}
        <div class="sec">&#9662; Direct messages</div>
        <div class="row ${opts.dmMode ? 'on' : ''}">&#9679; IT-Automation-Bot</div>
        <div class="row">&#9679; Priya Raman</div>
        <div class="row">&#9679; Marco Lindqvist</div>
      </div>
      <div class="main">
        <div class="chead">
          <span class="name">${esc(opts.channel)}</span>
          <span class="meta">${esc(opts.members ?? '')}</span>
        </div>
        <div class="msgs">
          ${opts.messages
            .map(
              (m) =>
                `${m.unreadBefore ? '<div class="divider"><div class="line"></div><div class="lbl">New</div></div>' : ''}
                 <div class="msg">
                   <div class="av" style="background:${m.color}">${m.initials}</div>
                   <div><div><span class="who">${esc(m.who)}</span><span class="t">${m.time}</span></div>
                   <div class="txt">${esc(m.text)}</div></div>
                 </div>`,
            )
            .join('')}
        </div>
        <div class="compose">Message ${esc(opts.channel)}</div>
      </div>
    </div>`,
  });
}

const NOTION_CSS = `
  .n { display: flex; height: 100%; background: #fff; color: #37352f; }
  .nside { width: 244px; background: #fbfbfa; border-right: 1px solid #ededec; padding: 10px 8px; font-size: 14px; }
  .nside .u { display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-weight: 500; }
  .nside .i { padding: 5px 8px; color: #787774; border-radius: 4px; }
  .nside .p { padding: 5px 8px; border-radius: 4px; }
  .nside .p.on { background: #ecebea; font-weight: 500; }
  .nmain { flex: 1; min-width: 0; }
  .nbar { height: 45px; display: flex; align-items: center; padding: 0 16px; gap: 10px;
          color: #787774; font-size: 14px; border-bottom: 1px solid #f1f1ef; }
  .ndoc { padding: 46px 0 0 128px; max-width: 980px; }
  .ndoc h1 { font-size: 40px; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; }
  .ndoc h2 { font-size: 24px; margin-top: 30px; font-weight: 600; }
  .ndoc ul { margin: 10px 0 0 20px; }
  .ndoc li { font-size: 16px; line-height: 1.72; }
  .ndoc .empty { height: 30px; color: #c4c3c0; font-size: 16px; line-height: 30px; }
  .ndoc .caret { background: #37352f; height: 20px; }
`;

export function notion(opts: {
  title: string;
  sections: { heading: string; bullets?: string[]; cursor?: boolean; placeholder?: boolean }[];
  clock: string;
}): string {
  return page({
    app: 'Notion',
    menus: ['File', 'Edit', 'View', 'Window', 'Help'],
    clock: opts.clock,
    bg: '#fff',
    css: NOTION_CSS,
    body: `<div class="n">
      <div class="nside">
        <div class="u">&#9679; Cyrus — Solace</div>
        <div class="i">&#128269; Search</div><div class="i">&#9200; Updates</div><div class="i">&#9881; Settings</div>
        <div style="height:14px"></div>
        <div class="p">&#128193; Engineering</div>
        <div class="p on">&#128220; ${esc(opts.title)}</div>
        <div class="p">&#128220; Connector rename RFC</div>
        <div class="p">&#128220; Weekly notes</div>
        <div class="p">&#128220; Onboarding</div>
      </div>
      <div class="nmain">
        <div class="nbar">Engineering / ${esc(opts.title)}</div>
        <div class="ndoc">
          <h1>${esc(opts.title)}</h1>
          ${opts.sections
            .map(
              (s) => `<h2>${esc(s.heading)}</h2>
              ${
                s.bullets?.length
                  ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
                  : `<div class="empty">${s.cursor ? '<span class="caret"></span>' : s.placeholder ? 'Type something…' : ''}</div>`
              }`,
            )
            .join('')}
        </div>
      </div>
    </div>`,
  });
}

const LINEAR_CSS = `
  .l { display: flex; height: 100%; background: #191a23; color: #d0d6e0; }
  .lside { width: 230px; background: #14151c; padding: 12px 10px; font-size: 13.5px; }
  .lside .t { color: #fff; font-weight: 600; padding: 4px 8px 12px; }
  .lside .r { padding: 5px 8px; color: #969aa5; border-radius: 5px; }
  .lside .r.on { background: #23242e; color: #fff; }
  .lmain { flex: 1; min-width: 0; padding: 26px 44px; }
  .lkey { color: #7a7f8c; font-size: 13px; }
  .lmain h1 { font-size: 27px; margin: 8px 0 18px; color: #fff; font-weight: 600; }
  .field { margin-top: 20px; }
  .field .lab { font-size: 12.5px; color: #7a7f8c; text-transform: uppercase; letter-spacing: .04em; }
  .field .val { font-size: 15px; line-height: 1.6; margin-top: 6px; }
  .field .val.empty { color: #565b68; font-style: italic; }
  .props { position: absolute; right: 44px; top: 88px; width: 250px; font-size: 13.5px; }
  .props .p { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #23242e; }
  .props .p .k { color: #7a7f8c; } .props .p .v { color: #d0d6e0; }
  .props .p .v.empty { color: #565b68; }
  .caret { background: #d0d6e0; }
`;

export function linear(opts: {
  key: string;
  title: string;
  description: string;
  steps: string;
  stepsCursor?: boolean;
  clock: string;
}): string {
  return page({
    app: 'Linear',
    menus: ['File', 'Edit', 'View', 'Window', 'Help'],
    clock: opts.clock,
    bg: '#191a23',
    css: LINEAR_CSS,
    body: `<div class="l">
      <div class="lside">
        <div class="t">Solace Agent Mesh</div>
        <div class="r">&#9737; Inbox</div><div class="r">&#9633; My issues</div>
        <div class="r on">&#9636; Active</div><div class="r">&#9635; Backlog</div>
        <div class="r">&#128202; Cycle 14</div><div class="r">&#127919; Projects</div>
      </div>
      <div class="lmain" style="position:relative">
        <div class="lkey">${esc(opts.key)} &nbsp;·&nbsp; In Progress</div>
        <h1>${esc(opts.title)}</h1>
        <div class="field">
          <div class="lab">Description</div>
          <div class="val">${esc(opts.description)}</div>
        </div>
        <div class="field">
          <div class="lab">Steps to reproduce</div>
          <div class="val">${esc(opts.steps)}${opts.stepsCursor ? '<span class="caret"></span>' : ''}</div>
        </div>
        <div class="props">
          <div class="p"><span class="k">Status</span><span class="v">In Progress</span></div>
          <div class="p"><span class="k">Assignee</span><span class="v empty">Unassigned</span></div>
          <div class="p"><span class="k">Severity</span><span class="v empty">—</span></div>
          <div class="p"><span class="k">Cycle</span><span class="v">Cycle 14</span></div>
          <div class="p"><span class="k">Labels</span><span class="v">broker</span></div>
        </div>
      </div>
    </div>`,
  });
}

const GH_CSS = `
  .gh { height: 100%; background: #0d1117; color: #e6edf3; }
  .ghbar { height: 42px; background: #161b22; border-bottom: 1px solid #30363d;
           display: flex; align-items: center; padding: 0 16px; gap: 14px; font-size: 13px; color: #8b949e; }
  .urlbar { height: 40px; background: #22272e; display: flex; align-items: center; padding: 0 16px; gap: 10px;
            font-size: 13px; color: #adbac7; border-bottom: 1px solid #30363d; }
  .urlbar .u { background: #1c2128; border-radius: 6px; padding: 5px 12px; flex: 1; max-width: 760px; }
  .ghhead { padding: 16px 30px 12px; border-bottom: 1px solid #21262d; }
  .ghhead h1 { font-size: 26px; font-weight: 400; }
  .ghhead h1 .num { color: #8b949e; }
  .ghhead .sub { margin-top: 8px; font-size: 13px; color: #8b949e; }
  .pill { background: #1f6feb; color: #fff; border-radius: 20px; padding: 4px 11px; font-size: 12.5px; margin-right: 8px; }
  .tabs { display: flex; gap: 22px; padding: 10px 30px 0; font-size: 14px; color: #8b949e; }
  .tabs .on { color: #e6edf3; border-bottom: 2px solid #f78166; padding-bottom: 8px; }
  .diff { margin: 16px 30px; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
  .diff .f { background: #161b22; padding: 8px 14px; font-size: 12.5px; font-family: ui-monospace, Menlo, monospace; }
  .diff pre { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; line-height: 1.55; padding: 4px 0; }
  .diff .ln { display: block; padding: 0 14px; white-space: pre; }
  .diff .add { background: #12261e; color: #aff5b4; }
  .diff .del { background: #25171c; color: #ffdcd7; }
  .diff .hunk { background: #0c2d6b33; color: #8b949e; }
`;

export function githubPr(opts: {
  title: string;
  number: string;
  file: string;
  fileIndex: string;
  lines: { kind: 'ctx' | 'add' | 'del' | 'hunk'; text: string }[];
  clock: string;
}): string {
  return page({
    app: 'Chrome',
    menus: ['File', 'Edit', 'View', 'History', 'Bookmarks', 'Window'],
    clock: opts.clock,
    bg: '#0d1117',
    css: GH_CSS,
    body: `<div class="gh">
      <div class="urlbar">
        <span>&#8249; &#8250;</span>
        <span class="u">github.com/solacedev/sam/pull/${opts.number}/files</span>
        <span>&#9734;</span>
      </div>
      <div class="ghbar"><span>solacedev / sam</span><span>Pull requests</span><span>Issues</span><span>Actions</span></div>
      <div class="ghhead">
        <h1>${esc(opts.title)} <span class="num">#${opts.number}</span></h1>
        <div class="sub"><span class="pill">Open</span> priya wants to merge 7 commits into <b>main</b> from <b>connector-shim</b></div>
      </div>
      <div class="tabs"><span>Conversation</span><span>Commits</span><span>Checks</span><span class="on">Files changed 11</span></div>
      <div class="diff">
        <div class="f">${esc(opts.file)} &nbsp; — file ${esc(opts.fileIndex)}</div>
        <pre>${opts.lines
          .map(
            (l) =>
              `<span class="ln ${l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : l.kind === 'hunk' ? 'hunk' : ''}">${esc(l.text)}</span>`,
          )
          .join('')}</pre>
      </div>
    </div>`,
  });
}

const READER_CSS = `
  .sf { height: 100%; background: #fff; color: #1d1d1f; }
  .sfbar { height: 52px; background: #f6f6f7; border-bottom: 1px solid #dcdcde;
           display: flex; align-items: center; gap: 12px; padding: 0 16px; font-size: 13px; color: #6e6e73; }
  .sfbar .u { flex: 1; max-width: 720px; margin: 0 auto; background: #e9e9eb; border-radius: 7px;
              padding: 6px 14px; text-align: center; color: #1d1d1f; }
  .doc { padding: 30px 60px; overflow: hidden; height: calc(100% - 52px); }
`;

export function reader(opts: { url: string; html: string; clock: string; app?: string }): string {
  return page({
    app: opts.app ?? 'Safari',
    menus: ['File', 'Edit', 'View', 'History', 'Bookmarks', 'Window'],
    clock: opts.clock,
    bg: '#fff',
    css: READER_CSS,
    body: `<div class="sf">
      <div class="sfbar"><span>&#8249; &#8250;</span><span class="u">${esc(opts.url)}</span><span>&#10530;</span></div>
      <div class="doc">${opts.html}</div>
    </div>`,
  });
}

const MAIL_CSS = `
  .m { display: flex; height: 100%; background: #fff; color: #1d1d1f; }
  .mside { width: 210px; background: #f2f2f4; border-right: 1px solid #dcdcde; padding: 12px 10px; font-size: 13.5px; }
  .mside .r { padding: 5px 9px; border-radius: 5px; color: #3a3a3c; }
  .mside .r.on { background: #d8d8dc; }
  .mlist { width: 320px; border-right: 1px solid #dcdcde; }
  .mlist .it { padding: 11px 14px; border-bottom: 1px solid #ededef; font-size: 13px; }
  .mlist .it.on { background: #2e6fdf; color: #fff; }
  .mlist .it .s { font-weight: 600; font-size: 13.5px; }
  .mlist .it .p { color: #6e6e73; }
  .mlist .it.on .p { color: #dbe6fb; }
  .mcomp { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .mcomp .hdr { border-bottom: 1px solid #dcdcde; padding: 10px 18px; font-size: 13.5px; }
  .mcomp .hdr .row { padding: 4px 0; color: #6e6e73; }
  .mcomp .hdr .row b { color: #1d1d1f; font-weight: 400; }
  .mcomp .body { padding: 20px 22px; font-size: 15px; line-height: 1.6; max-width: 760px; }
  .mcomp .body p { margin-bottom: 14px; }
  .caret { background: #1d1d1f; }
`;

export function mail(opts: {
  to: string;
  subject: string;
  paragraphs: string[];
  trailing: string;
  clock: string;
}): string {
  return page({
    app: 'Mail',
    menus: ['File', 'Edit', 'View', 'Mailbox', 'Message', 'Window'],
    clock: opts.clock,
    bg: '#fff',
    css: MAIL_CSS,
    body: `<div class="m">
      <div class="mside">
        <div class="r on">&#9993; Inbox <span style="float:right;color:#8e8e93">12</span></div>
        <div class="r">&#128172; Drafts <span style="float:right;color:#8e8e93">3</span></div>
        <div class="r">&#10148; Sent</div><div class="r">&#128465; Trash</div>
      </div>
      <div class="mlist">
        <div class="it on"><div class="s">Re: ${esc(opts.subject.replace(/^Re:\s*/, ''))}</div><div class="p">Draft — ${esc(opts.to)}</div></div>
        <div class="it"><div class="s">Q4 renewal quote</div><div class="p">Dana Whitfield — pricing for next year…</div></div>
        <div class="it"><div class="s">Northwind — signed contract</div><div class="p">legal@northwind.example — attached</div></div>
        <div class="it"><div class="s">Weekly digest</div><div class="p">Linear — 14 issues updated</div></div>
      </div>
      <div class="mcomp">
        <div class="hdr">
          <div class="row">To: <b>${esc(opts.to)}</b></div>
          <div class="row">Subject: <b>${esc(opts.subject)}</b></div>
        </div>
        <div class="body">
          ${opts.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
          <p>${esc(opts.trailing)}<span class="caret"></span></p>
        </div>
      </div>
    </div>`,
  });
}
