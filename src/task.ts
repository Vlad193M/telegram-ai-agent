/**
 * What the agent must achieve. Everything booking-specific lives here.
 *
 * @module
 */

export const TIMEZONE = 'Europe/London'

/** Requested time, London time. Set a later time for tests if 17:00 has already passed. */
export const BOOKING_TIME = '17:00'

export const PARTY_SIZE = 2

/** Short task name, used in the prompt and the log heading. */
export const TITLE = `Book a table for ${PARTY_SIZE} at ${BOOKING_TIME} today`

/**
 * Time in London, regardless of the computer's timezone.
 * @param date - Moment to format, now by default.
 * @returns Time like `14:05`.
 */
export const londonTime = (date = new Date()): string =>
  date.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' })

/**
 * Date in London, regardless of the computer's timezone.
 * @param date - Moment to format, now by default.
 * @returns Date like `Thursday, 19 November 2026`.
 */
export const londonDate = (date = new Date()): string =>
  date.toLocaleDateString('en-GB', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

/**
 * Builds the task description for the model.
 * @returns Task prompt with the current London date and time.
 */
export function taskPrompt(): string {
  const today = londonDate()
  return `# Task: ${TITLE}
You are talking to the manager of a restaurant in London, in British English.

## Goal
Book a table for ${PARTY_SIZE} people at ${BOOKING_TIME} today (${today}) at the manager's restaurant,
and get a clear confirmation in the chat.

## Facts
- Party size: ${PARTY_SIZE} people.
- Time: ${BOOKING_TIME} London time, today - ${today}.
- You do NOT know the restaurant's name. Ask the manager for it if they have not mentioned it.
- Everything else on your side (the name for the booking, a phone number, dietary needs,
  whether another time or date is acceptable) is unknown to you: get it via ask_operator.

## Style
- You start the conversation: a warm, polite British greeting, then the request.
- Courteous British manners: "please", "thank you", "would it be possible", never pushy or over-familiar.
- Short messages, like a real person in a messenger. One question at a time.

## Done when
- Success: the manager has clearly agreed to the booking. Then call finish with status "success" and
  a final_message that repeats the confirmed booking - time, date, number of people and the
  restaurant's name - and thanks them.
- The recap uses the time and date actually agreed in the chat: if the operator approved a different
  time or date, that one, not ${BOOKING_TIME} today.
- If the restaurant's name is still unknown when the manager agrees, ask for it before the recap.
- An ambiguous answer ("should be fine", "probably") is not a confirmation: politely ask them to confirm.
- If the manager offers a different time or date, do not accept it yourself: ask_operator first.
- If it is already past ${BOOKING_TIME} in London (${londonTime()} now), do not request the booking: ask_operator.
- If the booking is impossible, call finish with status "failed" and a final_message that politely
  thanks them.
- After finish, stay attentive: if the manager later changes or cancels the booking, don't argue and
  don't invent what happened - acknowledge politely, ask_operator what to do, and call finish again
  with the updated outcome.`
}
