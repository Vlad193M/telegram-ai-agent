/**
 * Decision log written by the agent itself: `logs/<timestamp>.md`, one line per event.
 * Times are in the task's timezone (London), the same as in the conversation.
 *
 * @module
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

import { TIMEZONE } from './task.ts'

/** The agent's reasoning for an action. */
export type Why = { understood: string; decision: string }

/** A decision log opened with {@link openLog}. */
export type Log = ReturnType<typeof openLog>

/**
 * Collapses whitespace and line breaks into single spaces.
 * @param s - Any text.
 * @returns The text on one line.
 */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Creates a new log file in `logs/`.
 * @param title - Heading of the log file.
 * @returns The file path and a `write` function.
 */
export function openLog(title: string) {
  mkdirSync('logs', { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
  const path = `logs/${stamp}.md`
  const started = new Date().toLocaleString('en-GB', { timeZone: TIMEZONE })
  writeFileSync(path, `# Decision log - ${title}\n\nStarted ${started} (${TIMEZONE} time)\n\n`)

  /**
   * Appends one line to the log file and prints it to the console.
   * @param label - Event type, e.g. `➡️ AGENT`.
   * @param text - Message or question text.
   * @param why - What the agent understood and decided.
   */
  function write(label: string, text?: string, why?: Why): void {
    let line = `- \`${new Date().toLocaleTimeString('en-GB', { timeZone: TIMEZONE })}\` **${label}**`
    if (text) line += `: “${oneLine(text)}”`
    if (why) line += ` — understood: ${oneLine(why.understood)} — decided: ${oneLine(why.decision)}`
    appendFileSync(path, line + '\n')
    console.log(line)
  }

  return { path, write }
}
