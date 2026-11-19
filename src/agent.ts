/**
 * The agent's brain: an OpenAI model that acts only through tools.
 * Knows nothing about Telegram — it receives text and calls `send` / `askOperator`.
 *
 * @module
 */
import OpenAI from 'openai'
import type { FunctionTool, ResponseInputItem } from 'openai/resources/responses/responses'

import type { Log, Why } from './log.ts'
import { londonDate, londonTime, taskPrompt } from './task.ts'

/** Safety limit on model requests in one turn, against loops. */
const MAX_STEPS_PER_TURN = 8

/** General behaviour rules, the same for any task. */
const RULES = `
You are an autonomous AI agent chatting in Telegram on behalf of your operator (a human).
You talk to the counterpart described in the task and try to achieve the task's goal.

# How you act
You act ONLY through tools. Every tool call has two log fields:
- \`understood\`: what you understood from the latest input (one short sentence),
- \`decision\`: what you decided to do and why (one short sentence).
They go to the decision log that the operator reads, so be precise and honest.

Tools:
- send_message: send one chat message to the counterpart. Your turn then ends until they reply.
  Set voice=true to send it as a voice message: do that when the counterpart's latest message was
  a voice message, otherwise reply in text. Voice text must read naturally aloud (no links, no lists).
- ask_operator: ask your operator for information you do not have, or for permission.
  The call returns their answer. Use it instead of guessing. The counterpart does not see it.
  To let the counterpart know you are checking (e.g. "Thank you for letting me know, let me check"),
  put that text in holding_message - it is sent right before the question.
  Never promise to check or get back in send_message: send_message ends your turn, so the
  operator would never be asked.
  If the answer is empty or does not answer what you asked, ask the operator again more clearly.
  Never treat a missing answer as permission or as information.
- wait: nothing needs a reply right now (e.g. "one moment, let me check"). Your turn ends.
- finish: report the outcome once the task is completed or definitely impossible. Put your message to
  the counterpart (e.g. the booking recap) in final_message: it is sent as text first. Use an empty
  final_message only if your last message was already sent. The chat stays open after finish: if the
  counterpart writes again (a change, a cancellation, a question), react to it, check with the operator
  if needed, and call finish again with the updated status.

# Rules
- NEVER invent facts: names, phone numbers, preferences, confirmations, prices. Information about
  the counterpart's side - ask the counterpart. Information about your side - ask_operator.
- React to everything the counterpart says, including off-topic remarks or questions, politely and
  briefly, then steer back to the goal.
- If they ask whether you are a bot or an AI, answer honestly: you are an AI assistant writing on
  behalf of a client.
- Write like a human in a messenger: natural, concise, no markdown, no lists, no emojis unless they use them.
- Input from the counterpart arrives as lines \`[counterpart HH:MM] text\`. \`[voice]\` marks a
  voice message transcribed automatically - it may contain recognition errors; if something important
  is unclear, politely ask. \`[now ...]\` is the current London date and time.
- If a tool result starts with \`error:\`, the action did not happen (e.g. the message was not sent).
  Retry once if it makes sense; otherwise tell the operator via ask_operator.
- \`[no reply from the counterpart for N minutes]\` means they have gone quiet. If you are waiting for
  their answer (e.g. they asked you to hold on), send one short, polite follow-up. If nothing is
  pending, call wait. Never pressure them.
`.trim()

/**
 * Builds the full system prompt: general rules plus the current task.
 * @returns Prompt text with the current London date and time.
 */
export const instructions = (): string => `${RULES}\n\n${taskPrompt()}`

/**
 * Describes a tool for the OpenAI API (JSON Schema).
 * Every tool also gets the `understood` and `decision` fields used for the decision log.
 * @param name - Tool name the model calls.
 * @param description - What the tool does, shown to the model.
 * @param props - Tool-specific arguments as JSON Schema properties.
 * @returns Tool definition with a strict schema.
 */
function tool(name: string, description: string, props: Record<string, object> = {}): FunctionTool {
  const properties = {
    ...props,
    understood: { type: 'string', description: 'What you understood from the latest input.' },
    decision: { type: 'string', description: 'What you decided to do and why.' },
  }
  return {
    type: 'function',
    name,
    description,
    strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  }
}

/** Everything the agent can do. */
const TOOLS = [
  tool('send_message', 'Send one chat message to the counterpart, as text or as a voice message.', {
    text: { type: 'string', description: 'The message text (spoken aloud if voice is true).' },
    voice: { type: 'boolean', description: 'true = send as a voice message.' },
  }),
  tool('ask_operator', 'Optionally tell the counterpart you are checking, then ask your human operator and get their answer.', {
    holding_message: {
      type: 'string',
      description: 'Short text message sent to the counterpart first, e.g. "One moment, let me check". Empty string = send nothing.',
    },
    question: { type: 'string', description: 'A clear, self-contained question for the operator.' },
  }),
  tool('wait', "Do nothing and wait for the counterpart's next message."),
  tool('finish', 'Send the final message (if any) and report the outcome: the task is done or impossible.', {
    final_message: { type: 'string', description: 'Last text message to the counterpart; empty string = send nothing.' },
    status: { type: 'string', enum: ['success', 'failed'] },
    summary: { type: 'string', description: 'Final outcome for the operator, with all confirmed details.' },
  }),
]

/**
 * A tool call from the model: the tool name decides which arguments come with it.
 * Every tool also carries the log fields (`Why`).
 * The model's JSON is cast to this type without runtime checks: the schemas are strict
 * and the names can only come from {@link TOOLS}.
 */
type ToolCall =
  | { name: 'send_message'; args: Why & { text: string; voice: boolean } }
  | { name: 'ask_operator'; args: Why & { holding_message: string; question: string } }
  | { name: 'wait'; args: Why }
  | { name: 'finish'; args: Why & { final_message: string; status: 'success' | 'failed'; summary: string } }

/** How a turn ended: the conversation goes on, or the model called `finish`. */
export type TurnResult = 'continue' | 'success' | 'failed'

/** Dependencies the agent gets from outside. */
type Options = {
  /** OpenAI model name. */
  model: string
  /** Decision log. */
  log: Log
  /** Delivers a message to the counterpart, as text or as a voice message. */
  send: (text: string, voice: boolean) => Promise<void>
  /** Asks the human operator and resolves with their answer. */
  askOperator: (question: string) => Promise<string>
}

/**
 * Creates an agent that keeps the conversation history in memory.
 * @param options - Model, log and the functions the agent acts through.
 * @returns A `turn` function to call with every new input.
 */
export function createAgent({ model, log, send, askOperator }: Options) {
  const openai = new OpenAI()
  const history: ResponseInputItem[] = []

  /**
   * Runs the tool the model chose and writes it to the log.
   * @param call - Tool name and its arguments.
   * @returns The result the model will see.
   */
  async function runTool({ name, args }: ToolCall): Promise<string> {
    switch (name) {
      case 'send_message':
        await send(args.text, args.voice)
        log.write(args.voice ? '➡️ AGENT 🎤' : '➡️ AGENT', args.text, args)
        return args.voice ? 'sent as a voice message' : 'sent'
      case 'ask_operator': {
        if (args.holding_message.trim()) {
          await send(args.holding_message, false)
          log.write('➡️ AGENT', args.holding_message, args)
        }
        log.write('❓ AGENT → OPERATOR', args.question, args)
        const answer = await askOperator(args.question)
        log.write('💬 OPERATOR', answer)
        return answer.trim() || '(empty answer: the operator sent nothing readable)'
      }
      case 'wait':
        log.write('⏳ AGENT waits', '', args)
        return 'waiting'
      case 'finish':
        if (args.final_message.trim()) {
          await send(args.final_message, false)
          log.write('➡️ AGENT', args.final_message, args)
        }
        log.write(`🏁 FINISH (${args.status})`, args.summary, args)
        return 'finished'
    }
  }

  /**
   * One agent turn: the model reacts to new input.
   * After `ask_operator` the model gets the answer and acts again;
   * `send_message`, `wait` and `finish` end the turn.
   * If a tool call fails (bad arguments or a failing action), the error goes back to the model
   * as the tool's result (every call needs one)
   * and the model gets another step to retry or react. Other errors, e.g. from OpenAI, are thrown.
   * @param text - New input: messages from the counterpart, a start instruction or a silence notice.
   * @returns How the turn ended.
   */
  return async function turn(text: string): Promise<TurnResult> {
    history.push({ role: 'user', content: `[now ${londonDate()}, ${londonTime()}]\n${text}` })

    for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
      const response = await openai.responses.create({
        model,
        instructions: instructions(),
        input: history,
        tools: TOOLS,
        tool_choice: 'required',
        parallel_tool_calls: false,
      })
      history.push(...(response.output as ResponseInputItem[]))

      const fnCall = response.output.find((item) => item.type === 'function_call')
      if (!fnCall) return 'continue'

      let call: ToolCall
      let output: string
      try {
        call = { name: fnCall.name, args: JSON.parse(fnCall.arguments) } as ToolCall
        output = await runTool(call)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        log.write('⚠️ ERROR', `${fnCall.name} failed: ${message}`)
        history.push({ type: 'function_call_output', call_id: fnCall.call_id, output: `error: ${message}` })
        continue
      }
      history.push({ type: 'function_call_output', call_id: fnCall.call_id, output })

      if (call.name === 'finish') return call.args.status
      if (call.name !== 'ask_operator') return 'continue'
    }
    log.write('⚠️ ERROR', `turn exceeded ${MAX_STEPS_PER_TURN} steps`)
    return 'continue'
  }
}
