/**
 * Voice messages: speech-to-text for incoming ones, text-to-speech for outgoing ones (OpenAI).
 *
 * @module
 */
import OpenAI, { toFile } from 'openai'

const STT_MODEL = 'gpt-4o-mini-transcribe'
const TTS_MODEL = 'gpt-4o-mini-tts'
const TTS_VOICE = 'fable'

/** How the generated voice should sound. */
const TTS_STYLE = 'Speak like a polite, friendly Londoner on the phone: natural British accent, calm pace.'

let client: OpenAI | undefined

/**
 * Returns the OpenAI client, creating it on first use.
 * It can't be created at import time: imports run before main.ts loads `.env`.
 * @returns Shared OpenAI client.
 */
const openai = (): OpenAI => (client ??= new OpenAI())

/**
 * Transcribes a Telegram voice message.
 * @param audio - Voice file as downloaded from Telegram (OGG/Opus).
 * @returns The recognised text.
 */
export async function transcribe(audio: Uint8Array): Promise<string> {
  const result = await openai().audio.transcriptions.create({
    model: STT_MODEL,
    file: await toFile(audio, 'voice.ogg'),
  })
  return result.text.trim()
}

/**
 * Generates a voice message from text.
 * OpenAI returns OGG/Opus, the format Telegram needs for voice messages.
 * @param text - What to say.
 * @returns The audio file and its duration in seconds.
 */
export async function speak(text: string): Promise<{ audio: Uint8Array; duration: number }> {
  const response = await openai().audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: text,
    instructions: TTS_STYLE,
    response_format: 'opus',
  })
  const audio = new Uint8Array(await response.arrayBuffer())
  return { audio, duration: oggDuration(audio) }
}

/**
 * Reads the duration of an OGG/Opus file without decoding it.
 * The last OGG page stores the total number of samples (at 48 kHz),
 * minus the encoder delay ("pre-skip") written in the Opus header.
 * @param ogg - OGG/Opus file.
 * @returns Duration in whole seconds, at least 1.
 */
function oggDuration(ogg: Uint8Array): number {
  const view = new DataView(ogg.buffer, ogg.byteOffset, ogg.byteLength)
  const lastPage = Buffer.from(ogg).lastIndexOf('OggS')
  const opusHead = Buffer.from(ogg).indexOf('OpusHead')
  if (lastPage < 0 || opusHead < 0) return 1
  const samples = Number(view.getBigInt64(lastPage + 6, true))
  const preSkip = view.getUint16(opusHead + 10, true)
  return Math.max(1, Math.round((samples - preSkip) / 48_000))
}
