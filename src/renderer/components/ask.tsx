import React, { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../useBuddy.js';
import { Card, spring, useMotionSafe } from '../components/primitives.js';
import type { DayAnswer, OperatorAvailability } from '../../shared/types.js';

/// §8.2's "single input that accepts either a question or a direct
/// instruction", and the ask-about-my-day answer it produces.
///
/// One field, two destinations, and the routing is the interesting part.
/// Splitting it into two boxes would have been easier to build and worse to
/// use: a person mid-thought does not first classify what they are about to
/// type. So the box guesses — a question mark, or an opening interrogative —
/// and then **says which way it is about to go, before you press Enter**,
/// because a guess that acts silently is a guess that occasionally drives
/// someone's machine when they meant to ask a question.
///
/// The guess is deliberately conservative in one direction. "what did I do this
/// morning" reads as a question and gets answered. Everything else runs, which
/// is the product's default mood — but it runs through the HUD, where there is
/// a confirmation step, an inferred goal to compare against, and an Esc key.

const QUESTION_WORDS =
  /^(what|when|where|who|which|why|how|did|do|does|was|were|is|are|have|has|had|can|could|should|would|tell me|remind me|summar)/i;

export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  return QUESTION_WORDS.test(t);
}

export function AskBox({ operator }: { operator: OperatorAvailability | null }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<DayAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const safe = useMotionSafe();

  const asking = isQuestion(text);

  const submit = useCallback(async () => {
    const t = text.trim();
    if (!t || busy) return;
    setError(null);

    if (!isQuestion(t)) {
      // An instruction goes where every instruction goes: the HUD, with the
      // goal in it and a key to confirm. It is never dispatched from here.
      setText('');
      await api.activate();
      return;
    }

    setBusy(true);
    try {
      setAnswer(await api.askAboutMyDay(t));
    } catch (e) {
      setError(
        (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      );
    } finally {
      setBusy(false);
    }
  }, [text, busy]);

  return (
    <div className="flex flex-col gap-3">
      <div
        className={`flex items-center gap-2 rounded-xl border bg-ink-900 px-3 py-2 transition-colors
                    ${asking ? 'border-ember-500/50' : 'border-ink-700 focus-within:border-ink-600'}`}
      >
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask what you did, or say what you want finished…"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-fog-100 outline-none
                     placeholder:text-fog-500/70"
        />
        <span
          className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase
                      tracking-wider transition-colors ${
                        text.trim()
                          ? asking
                            ? 'border-ember-500/40 bg-ember-500/10 text-ember-300'
                            : 'border-ink-600 bg-ink-800 text-fog-300'
                          : 'border-transparent text-transparent'
                      }`}
        >
          {asking ? 'answer' : 'run it'}
        </span>
        <button
          onClick={() => void submit()}
          disabled={!text.trim() || busy}
          className="shrink-0 rounded-lg bg-ember-500 px-2.5 py-1 text-[11px] font-medium
                     text-ink-950 transition-colors hover:bg-ember-400 disabled:opacity-30"
        >
          {busy ? 'reading…' : '⏎'}
        </button>
      </div>

      {!asking && text.trim() && operator && !operator.available && (
        <p className="text-[11px] leading-relaxed text-ember-300">{operator.reason}</p>
      )}

      {error && (
        <p className="rounded-lg border border-rust-400/40 bg-rust-400/10 px-3 py-2 text-[11px] text-rust-400">
          {error}
        </p>
      )}

      <AnimatePresence>
        {answer && (
          <motion.div
            initial={safe ? { opacity: 0, y: -6 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={safe ? { opacity: 0 } : { opacity: 0 }}
            transition={safe ? spring : { duration: 0 }}
          >
            <Card className="p-4">
              <p className="text-[10px] uppercase tracking-[0.09em] text-fog-500">
                {answer.question}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-fog-100">
                {answer.answer}
              </p>
              {answer.cited.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-ink-700/60 pt-3">
                  {/* The citations are the whole reason to trust the answer:
                      buddy claiming to remember is not the same as buddy being
                      able to show you the note it remembered from. */}
                  {answer.cited.map((c) => (
                    <span
                      key={c.id}
                      className="rounded-md border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-[10px] text-fog-300"
                      title={`${c.type} note #${c.id}`}
                    >
                      {c.title.slice(0, 60)}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center justify-between border-t border-ink-700/60 pt-2.5">
                <span className="font-mono text-[10px] text-fog-500">
                  {answer.provider} · {answer.model} · {(answer.ms / 1000).toFixed(1)}s · $
                  {answer.costUsd.toFixed(4)}
                </span>
                <button
                  onClick={() => setAnswer(null)}
                  className="text-[11px] text-fog-500 transition-colors hover:text-fog-100"
                >
                  Clear
                </button>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
