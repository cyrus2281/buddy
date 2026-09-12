import React, { useMemo, useState } from 'react';
import { Card } from '../components/primitives.js';
import type { LogEntry } from '../../shared/types.js';

/// The structured log, visible in the app. M1 needs this because the sidecar is
/// a separate process: when capture stops, the reason is a line in here, and
/// "check the terminal" is not an answer for a menu-bar app.

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  debug: 'text-fog-500',
  info: 'text-fog-300',
  warn: 'text-ember-300',
  error: 'text-rust-400',
};

const ORDER: LogEntry['level'][] = ['debug', 'info', 'warn', 'error'];

export function Logs({ logs }: { logs: LogEntry[] }) {
  const [minLevel, setMinLevel] = useState<LogEntry['level']>('info');

  const visible = useMemo(
    () => logs.filter((l) => ORDER.indexOf(l.level) >= ORDER.indexOf(minLevel)).slice(-300).reverse(),
    [logs, minLevel],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-medium text-fog-100">Log</h3>
        <div className="flex gap-1">
          {ORDER.map((l) => (
            <button
              key={l}
              onClick={() => setMinLevel(l)}
              className={`rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                minLevel === l ? 'bg-ink-700 text-fog-100' : 'text-fog-500 hover:text-fog-300'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <Card className="max-h-[60vh] overflow-auto p-1">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-fog-500">Nothing at this level yet.</p>
        ) : (
          <ul className="divide-y divide-ink-800/70">
            {visible.map((l, i) => (
              <li key={`${l.t}-${i}`} className="flex gap-3 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
                <span className="shrink-0 text-fog-500 tabular-nums">
                  {new Date(l.t).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={`w-11 shrink-0 uppercase ${LEVEL_COLOR[l.level]}`}>{l.level}</span>
                <span className="w-20 shrink-0 truncate text-ember-300/70">{l.scope}</span>
                <span className="min-w-0 flex-1 break-words text-fog-300">
                  {l.msg}
                  {l.fields && Object.keys(l.fields).length > 0 && (
                    <span className="ml-2 text-fog-500">
                      {Object.entries(l.fields)
                        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                        .join('  ')}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
