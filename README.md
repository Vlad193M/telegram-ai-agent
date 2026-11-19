# Telegram AI Agent

An AI agent that runs a Telegram conversation on a person's behalf. The current task: **book a table for 2 at 17:00 today at a London restaurant**. The agent messages the manager first, in English with British manners, reacts to everything the manager says, never invents facts, and finally repeats the confirmed booking: time, date, number of people and restaurant.

## Features

- **Starts the conversation itself.** It runs as a userbot over MTProto (a regular Telegram account), not as a Bot API bot, which cannot message a user first.
- **Acts only through tools:** `send_message`, `ask_operator`, `wait`, `finish`.
- **Never makes things up.** Anything it doesn't know about its own side (name for the booking, whether another time is fine) it asks the operator via Telegram's *Saved Messages*. Anything about the restaurant it asks the manager.
- **Writes its own decision log:** one line per message: what it sent, what it understood, what it decided.
- **Voice messages:** transcribes the manager's voice messages and answers a voice message with a voice message in a generated British voice.
- **Behaves like a person:** shows "typing…" / "recording a voice message…" before replying, and answers several messages sent in a row with a single reply.

## Stack

| Part | Choice |
|---|---|
| Language | TypeScript on Node.js 24, run with `tsx` |
| Telegram | [mtcute](https://mtcute.dev), an MTProto client; the session is stored in SQLite |
| Agent brain | OpenAI Responses API with function calling (`gpt-6-luna` by default) |
| Speech → text | OpenAI `gpt-4o-mini-transcribe` |
| Text → speech | OpenAI `gpt-4o-mini-tts`, output directly as OGG/Opus (no ffmpeg) |

## Setup

You need Node.js 24+, a Telegram account for the agent and an OpenAI API key.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Get `api_id` and `api_hash` at [my.telegram.org](https://my.telegram.org) → *API development tools*.
3. Copy `.env.example` to `.env` and fill it in:

   | Variable | Meaning |
   |---|---|
   | `TG_API_ID`, `TG_API_HASH` | App credentials from my.telegram.org |
   | `TG_SESSION` | Session file name (`agent` → `agent.mtcute.session`) |
   | `TARGET_USERNAME` | Username of the manager the agent talks to (your second account while testing) |
   | `OPENAI_API_KEY` | OpenAI API key |
   | `OPENAI_MODEL` | Agent model, `gpt-6-luna` by default |
   | `DEBOUNCE_SECONDS` | How long to wait for more messages before replying, 4 by default |
   | `FOLLOW_UP_MINUTES` | If the manager goes quiet, the agent may follow up politely after this many minutes (at most twice), 3 by default |
4. Log in to Telegram once. Enter the phone number as `+380...`; the code arrives in Telegram:
   ```bash
   npm run login
   ```

## Running

```bash
npm run check   # prints the manager, the model and the full prompt; sends nothing
npm start       # the agent messages the manager and keeps the conversation going until Ctrl+C
```

- The agent's questions arrive in your **Saved Messages**, prefixed with `🤖 Agent asks:`. Reply in the same chat. While the agent is running, don't post anything else there: any message counts as an answer.
- After the booking is confirmed the agent reports the outcome in Saved Messages but keeps listening, so a later change or cancellation from the manager still gets a reply. It runs until you stop it with `Ctrl+C`.
- Time and party size are set in [`src/task.ts`](src/task.ts) (`BOOKING_TIME`, `PARTY_SIZE`). If 17:00 has already passed in London, the agent asks the operator instead of requesting the booking, so set a later time for testing.

## Decision log

Every run creates `logs/<timestamp>.md` with one line per event:

```
- `14:05:12` **➡️ AGENT**: “Good afternoon! …” — understood: … — decided: …
- `14:05:40` **⬅️ COUNTERPART**: “Hello! For how many?”
- `14:05:48` **❓ AGENT → OPERATOR**: “What name should the booking be under?” — understood: … — decided: …
- `14:06:10` **💬 OPERATOR**: “Vlad”
- `14:07:02` **➡️ AGENT 🎤**: “…” — understood: … — decided: …
- `14:07:30` **➡️ AGENT**: “Wonderful, thank you! So that's a table for 2 at 17:00 today, …” — understood: … — decided: …
- `14:07:30` **🏁 FINISH (success)**: “Table for 2 at 17:00 …” — understood: … — decided: …
```

The model fills in `understood` and `decision` itself on every tool call.

## Project structure

```
src/
  main.ts    entry point, Telegram, conversation loop, operator
  agent.ts   the brain: rules, tools, OpenAI requests
  task.ts    the task: what to book, London date and time
  voice.ts   speech-to-text and text-to-speech
  log.ts     decision log in logs/*.md
docs/
  architecture.md   how it all works
```

See [docs/architecture.md](docs/architecture.md) for details.

## Security

`.env` and `*.session` are in `.gitignore` and must never be committed: the session file gives full access to the Telegram account without a login code. A session can be terminated in Telegram under *Settings → Devices*.
