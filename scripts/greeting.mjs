#!/usr/bin/env node
// SessionStart hook. If Guardian auto-resumed one or more times since you last opened an
// interactive session, greet you IN THE CHAT with a "while you were away" summary — once.
// Factual counts come from the ground-truth event log (real exit codes), not Claude's narrative.
import fs from 'node:fs';
import { loadConfig, readEvents, getGreetWatermark, setGreetWatermark, reportPath, fmtLocal, log } from './lib.mjs';

function done() { process.exit(0); }

try {
  // Never greet during Guardian's OWN autonomous resume (that's not the user returning).
  if (process.env.GUARDIAN_AUTONOMOUS === '1') done();

  const config = loadConfig();
  if (config.greeting === false) done();

  const wm = getGreetWatermark();
  const resumes = readEvents().filter((e) => e.type === 'resume_completed' && e.ts > wm);
  if (!resumes.length) done();

  const n = resumes.length;
  const ok = resumes.filter((e) => e.exit === 0).length;
  const fail = n - ok;
  const first = resumes[0], last = resumes[n - 1];
  const span = `${fmtLocal(new Date(first.ts).toISOString())}–${fmtLocal(new Date(last.ts).toISOString())}`;
  const lastStatus = last.exit === 0 ? 'exited cleanly' : `exited with error (code ${last.exit})`;

  let reportNote = '';
  try { if (fs.existsSync(reportPath())) reportNote = `\nA per-cycle report exists at ${reportPath()} — read it for the details (what shipped, what failed, repo state).`; } catch { /* ignore */ }

  const context =
`Session Guardian — WHILE YOU WERE AWAY.
Ground-truth from the event log: Guardian auto-resumed this work ${n} time(s) between ${span}. Process outcomes: ${ok} clean, ${fail} errored. The last resume ${lastStatus}.${reportNote}

Begin your FIRST reply to the user with a short "while you were away" summary, and follow these rules:
1. Lead with REASSURANCE about their repo — check actual state (git branch, commits, pushed or not, working tree clean/dirty) and say it first. The user's top fear is "what did it do to my repo while I slept?".
2. Then 3–5 bullets: cycles run, what was accomplished, what FAILED (be honest — do not launder failures into optimism), and what is BLOCKED needing them.
3. End with exactly where things stopped and the single next action.
Base facts on the report file and real command output, not guesses. If you cannot verify something, say so. Keep it tight.`;

  setGreetWatermark(Date.now());
  log(`greeting injected: ${n} resume(s), ${ok} ok / ${fail} fail`);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
} catch (e) {
  try { log(`greeting error: ${String(e && e.message || e)}`); } catch { /* ignore */ }
}
process.exit(0);
