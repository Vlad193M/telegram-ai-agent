/**
 * Entry point: Telegram channel and conversation loop.
 *
 * - `npm run login` — log in once, creates the session file
 * - `npm run check` — show the manager and the prompt, sends nothing
 * - `npm start` — talk to TARGET_USERNAME until Ctrl+C
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

import { InputMedia, type Message, SqliteStorage, TelegramClient, type User } from '@mtcute/node'

import { createAgent, instructions, type TurnResult } from './agent.ts'
import { openLog } from './log.ts'
import { londonTime, TITLE } from './task.ts'
import { speak, transcribe } from './voice.ts'

/** Prefix of the agent's own posts in Saved Messages, so they aren't taken as answers. */
const OPERATOR_MARK = '🤖 Agent'

const command = process.argv[2] ?? ''
if (!['login', 'check', 'run'].includes(command)) fail('Usage: tsx src/main.ts <login|check|run>')

if (existsSync('.env')) process.loadEnvFile('.env')
const target = env('TARGET_USERNAME').replace(/^@/, '')
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-6-luna'
const debounceMs = Number(process.env.DEBOUNCE_SECONDS || 4) * 1000
const followUpMinutes = Number(process.env.FOLLOW_UP_MINUTES || 3)

/** How many times in a row the agent may follow up when the manager goes quiet. */
const MAX_FOLLOW_UPS = 2

const tg = new TelegramClient({
  apiId: Number(env('TG_API_ID')),
  apiHash: env('TG_API_HASH'),
  storage: new SqliteStorage(`${process.env.TG_SESSION?.trim() || 'agent'}.mtcute.session`),
})

process.once('SIGINT', () => {
  console.log('\nStopped.')
  tg.destroy().finally(() => process.exit(130))
})

try {
  const me = await tg.start({
    phone: () => tg.input('Phone (+380...) > '),
    code: () => tg.input('Code from Telegram > '),
    password: () => tg.input('2FA password > '),
  })
  if (command === 'login') {
    console.log(`Logged in as ${me.displayName} (@${me.username}). Do NOT commit or share the session file.`)
  } else {
    const user = await tg.getUser(target)
    if (command === 'check') {
      console.log(`Manager: ${user.displayName} (@${user.username}), id=${user.id}`)
      console.log(`Model: ${model}\n\n${instructions()}`)
    } else {
      env('OPENAI_API_KEY')
      await run(me, user)
    }
  }
} finally {
  await tg.destroy()
}

/**
 * Runs the conversation until Ctrl+C.
 *
 * - Before an outcome, if the manager goes quiet for FOLLOW_UP_MINUTES, the agent is told so
 *   and may follow up (at most {@link MAX_FOLLOW_UPS} times in a row).
 * - Outcomes from `finish` are reported to the operator, but the agent keeps listening
 *   so it can react to later changes such as a cancellation.
 * - Questions to the operator go to the account's own Saved Messages.
 *
 * @param me - The logged-in account (the agent).
 * @param user - The manager.
 */
async function run(me: User, user: User): Promise<void> {
  const log = openLog(`${TITLE} (@${user.username})`)
  const fromManager: string[] = []
  const fromOperator: string[] = []

  tg.onNewMessage.add((msg) => {
    if (msg.chat.id === me.id) {
      if (msg.text.startsWith(OPERATOR_MARK)) return
      toText(msg).then((text) => fromOperator.push(text))
    } else if (msg.chat.id === user.id && !msg.isOutgoing) {
      toText(msg).then((text) => {
        log.write('⬅️ COUNTERPART', text)
        fromManager.push(`[counterpart ${londonTime(msg.date)}] ${text}`)
      })
    }
  })

  /**
   * Sends a message to the manager like a human would: "typing..." before text,
   * "recording a voice message..." before a voice message.
   * @param text - Message text, or what to say in the voice message.
   * @param voice - Send as a voice message.
   */
  async function sendToManager(text: string, voice: boolean): Promise<void> {
    if (voice) {
      await tg.setTyping({ peerId: user, status: 'record_voice' })
      const { audio, duration } = await speak(text)
      await tg.sendMedia(user, InputMedia.voice(audio, { duration }))
      return
    }
    await tg.setTyping({ peerId: user, status: 'typing' })
    await sleep(Math.min(1500 + text.length * 33, 6000))
    await tg.sendText(user, text)
  }

  /**
   * Posts a question to Saved Messages and waits for the operator's reply there.
   * Anything written there before the question is ignored.
   * @param question - Question for the operator.
   * @returns The operator's answer.
   */
  async function askOperator(question: string): Promise<string> {
    fromOperator.length = 0
    await tg.sendText('me', `${OPERATOR_MARK} asks:\n\n${question}\n\n(reply in this chat)`)
    console.log('❓ Question sent to your Saved Messages - answer there.')
    const answer = await takeWhenReady(fromOperator)
    return answer.join('\n')
  }

  const turn = createAgent({ model, log, send: sendToManager, askOperator })

  /**
   * Writes a non-fatal error to the decision log; the conversation goes on.
   * @param what - What was being done, e.g. `readHistory`.
   * @param e - The caught error.
   * @returns The error message.
   */
  function logError(what: string, e: unknown): string {
    const message = e instanceof Error ? e.message : String(e)
    log.write('⚠️ ERROR', `${what} failed: ${message}`)
    return message
  }

  /**
   * Runs a turn; if it fails (e.g. OpenAI is unavailable), logs the error, tells the operator
   * and lets the conversation go on: the next message from the manager starts a new turn.
   * @param text - Input for the turn.
   * @returns How the turn ended; `continue` after an error.
   */
  async function safeTurn(text: string): Promise<TurnResult> {
    try {
      return await turn(text)
    } catch (e) {
      const message = logError('turn', e)
      await tg
        .sendText('me', `${OPERATOR_MARK}: error, the agent keeps listening: ${message}`)
        .catch((e) => logError('error report to the operator', e))
      return 'continue'
    }
  }

  /**
   * Reports a new outcome to the operator; the conversation keeps running.
   * @param status - Outcome from the agent's `finish` call.
   */
  async function reportOutcome(status: string): Promise<void> {
    await tg
      .sendText('me', `${OPERATOR_MARK}: outcome: ${status}. Still listening to the manager. Log: ${log.path}`)
      .catch((e) => logError('outcome report to the operator', e))
    console.log(`\nOutcome: ${status}. Still listening (Ctrl+C to stop).\n`)
  }

  console.log(`Talking to @${user.username}. Ctrl+C to stop.\n`)
  let outcome: string | undefined
  let followUps = 0
  let result = await safeTurn('The conversation has not started yet. Open it now.')

  while (true) {
    if (result !== 'continue') {
      outcome = result
      await reportOutcome(outcome)
    }

    const canFollowUp = !outcome && followUps < MAX_FOLLOW_UPS
    const messages = await takeWhenReady(fromManager, canFollowUp ? followUpMinutes * 60_000 : Infinity)

    if (messages.length > 0) {
      followUps = 0
      await tg.readHistory(user).catch((e) => logError('readHistory', e))
      result = await safeTurn(messages.join('\n'))
    } else {
      followUps++
      result = await safeTurn(`[no reply from the counterpart for ${followUpMinutes * followUps} minutes]`)
    }
  }
}

/**
 * Waits until messages appear in `box`, then until no new ones arrive for
 * `DEBOUNCE_SECONDS` (people often send several messages in a row).
 * @param box - Array that the message handler fills.
 * @param timeoutMs - Give up if nothing arrives in this time; waits forever by default.
 * @returns All collected messages (`box` is emptied), or an empty array on timeout.
 */
async function takeWhenReady(box: string[], timeoutMs = Infinity): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  while (box.length === 0) {
    if (Date.now() >= deadline) return []
    await sleep(500)
  }
  let seen
  do {
    seen = box.length
    await sleep(debounceMs)
  } while (box.length > seen)
  return box.splice(0)
}

/**
 * Turns a Telegram message (from the manager or the operator) into text for the model.
 * Voice messages are transcribed.
 * @param msg - Incoming message.
 * @returns Message text, or a description for media without text.
 */
async function toText(msg: Message): Promise<string> {
  if (msg.media?.type === 'voice') {
    try {
      const audio = await tg.downloadAsBuffer(msg.media)
      return `[voice] ${await transcribe(audio)}`
    } catch (e) {
      console.error('Voice transcription failed:', e)
      return '[voice] (could not be transcribed)'
    }
  }
  return msg.text || '(sent a sticker/photo/file without text)'
}

/**
 * Reads a required environment variable.
 * @param name - Variable name.
 * @returns The trimmed value; exits the process if it is missing.
 */
function env(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) fail(`${name} is not set. Copy .env.example to .env and fill it in.`)
  return value
}

/**
 * Prints an error and exits with code 1.
 * @param message - Error message.
 */
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
