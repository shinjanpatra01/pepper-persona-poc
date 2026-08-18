import { requireEnv } from "../lib/env.js";
import { vapi, type VapiCall, type VapiPhoneNumber } from "./client.js";

/**
 * Telephony side of the Vapi adapter (PRD 4.3).
 *
 * Scope guardrail from PRD 7: exactly one number, no pool, no allocation
 * logic. importTwilioNumber exists only so the POC is reproducible from the
 * README rather than depending on clicks in a dashboard.
 */

/**
 * Register an existing Twilio number with Vapi.
 *
 * Vapi then owns the inbound/outbound wiring for that number; we never touch
 * Twilio webhooks by hand. Safe to call more than once - if the number is
 * already imported we return the existing record instead of erroring.
 */
export async function importTwilioNumber(): Promise<VapiPhoneNumber> {
  const number = requireEnv("TWILIO_PHONE_NUMBER");

  const existing = await vapi.get<VapiPhoneNumber[]>("/phone-number");
  const alreadyImported = existing.find((n) => n.number === number);
  if (alreadyImported) return alreadyImported;

  return vapi.post<VapiPhoneNumber>("/phone-number", {
    provider: "twilio",
    number,
    twilioAccountSid: requireEnv("TWILIO_ACCOUNT_SID"),
    twilioAuthToken: requireEnv("TWILIO_AUTH_TOKEN"),
  });
}

/** Resolve the phone number id to dial from, importing Twilio if needed. */
export async function resolvePhoneNumberId(): Promise<string> {
  // An explicit id wins - useful if you bought a number inside Vapi itself
  // and never involved Twilio at all.
  const configured = process.env.VAPI_PHONE_NUMBER_ID?.trim();
  if (configured) return configured;

  if (process.env.TWILIO_PHONE_NUMBER?.trim()) {
    const imported = await importTwilioNumber();
    return imported.id;
  }

  const numbers = await vapi.get<VapiPhoneNumber[]>("/phone-number");
  if (numbers.length === 0) {
    throw new Error(
      "No phone number available. Either set VAPI_PHONE_NUMBER_ID, or set the " +
        "TWILIO_* variables so the number can be imported, or buy a number in " +
        "the Vapi dashboard."
    );
  }
  return numbers[0]!.id;
}

export interface PlaceCallInput {
  assistantId: string;
  /** E.164 destination, e.g. +919876543210. */
  to: string;
}

/** Place one outbound test call (PRD 4.3, minimum requirement). */
export async function placeCall(input: PlaceCallInput): Promise<VapiCall> {
  const phoneNumberId = await resolvePhoneNumberId();

  return vapi.post<VapiCall>("/call", {
    assistantId: input.assistantId,
    phoneNumberId,
    customer: { number: input.to },
  });
}

/** Fetch a call afterwards to read its status, transcript and recording. */
export async function getCall(callId: string): Promise<
  VapiCall & {
    endedReason?: string;
    transcript?: string;
    recordingUrl?: string;
    startedAt?: string;
    endedAt?: string;
  }
> {
  return vapi.get(`/call/${callId}`);
}
