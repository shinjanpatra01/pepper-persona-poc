import OpenAI from "openai";
import type { ZodType } from "zod";
import { optionalEnv } from "./env.js";
import { toStrictJsonSchema } from "./jsonSchema.js";

/**
 * A single LLM entry point for the whole POC.
 *
 * xAI (Grok), OpenAI, Groq, Together, Fireworks and others all expose the same
 * OpenAI-compatible /chat/completions API, so we use the `openai` SDK for all
 * of them and change only the base URL and model name. Swapping providers is
 * therefore an .env edit, never a code edit - which matters here because the
 * POC's value is in the prompts and the Agent Spec, not in the vendor.
 */

interface LlmConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

function resolveConfig(): LlmConfig {
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.XAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error(
      "No LLM API key found. Set LLM_API_KEY (or XAI_API_KEY / OPENAI_API_KEY / " +
        "GROQ_API_KEY) in your .env file."
    );
  }

  return {
    apiKey,
    baseURL: optionalEnv("LLM_BASE_URL", "https://api.x.ai/v1"),
    model: optionalEnv("LLM_MODEL", "grok-4-fast"),
  };
}

let cached: { client: OpenAI; config: LlmConfig } | null = null;

function getClient() {
  if (!cached) {
    const config = resolveConfig();
    cached = {
      client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }),
      config,
    };
  }
  return cached;
}

/** Human-readable description of the active provider, for CLI output. */
export function describeLlm(): string {
  const { config } = getClient();
  return `${config.model} via ${config.baseURL}`;
}

/**
 * Retry transient provider failures with exponential backoff.
 *
 * Free-tier endpoints return 429 (rate limited) and 503 (overloaded) fairly
 * often, and a pipeline stage losing a minute of work to a blip is pure
 * friction. 4xx errors other than 429 are real mistakes on our side and are
 * rethrown immediately rather than retried.
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  const delaysMs = [2000, 5000, 15000, 30000];

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const transient = status === 429 || status === undefined || status >= 500;

      if (!transient || attempt >= delaysMs.length) throw error;

      // Providers usually say how long to wait; obeying that beats guessing.
      // Gemini phrases it as "Please retry in 24.04s" inside the error body.
      const message = String((error as Error).message ?? "");
      const hinted = message.match(/retry in ([\d.]+)s/i);
      const wait = hinted
        ? Math.ceil(Number(hinted[1]) * 1000) + 1000
        : delaysMs[attempt]!;

      console.warn(
        `  provider returned ${status ?? "a network error"}; waiting ${Math.round(
          wait / 1000
        )}s (attempt ${attempt + 2} of ${delaysMs.length + 1})...`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export interface CompleteOptions {
  system: string;
  user: string;
  /** 0 keeps extraction repeatable; raise only for creative generation. */
  temperature?: number;
}

/**
 * Ask the model for JSON matching a Zod schema, and return a validated object.
 *
 * Two independent guarantees:
 *   - the provider enforces the JSON Schema, so the SHAPE is always right
 *   - Zod re-validates on our side, so a provider that ignores strict mode
 *     (some compatible endpoints do) still cannot poison the pipeline
 *
 * On a validation failure we retry once, feeding the error back to the model.
 */
export async function completeJson<T>(
  options: CompleteOptions & { schema: ZodType<T>; schemaName: string }
): Promise<T> {
  const { client, config } = getClient();
  const jsonSchema = toStrictJsonSchema(options.schema);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.user },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await withRetry(() =>
      client.chat.completions.create({
        model: config.model,
        temperature: options.temperature ?? 0,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: options.schemaName,
            schema: jsonSchema,
            strict: true,
          },
        },
      })
    );

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("The model returned an empty response.");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`The model returned invalid JSON:\n${content.slice(0, 500)}`);
    }

    const result = options.schema.safeParse(parsed);
    if (result.success) return result.data;

    if (attempt === 2) {
      throw new Error(
        "The model's JSON did not match the schema after a retry:\n" +
          JSON.stringify(result.error.issues, null, 2)
      );
    }

    messages.push(
      { role: "assistant", content },
      {
        role: "user",
        content:
          "That response failed schema validation with these issues:\n" +
          JSON.stringify(result.error.issues, null, 2) +
          "\nReturn corrected JSON only.",
      }
    );
  }

  throw new Error("unreachable");
}

/**
 * Same contract as completeJson, but the user turn also carries audio.
 *
 * Multimodal input goes through the standard OpenAI "input_audio" content
 * part, which Gemini's compatibility endpoint accepts. Keeping it here rather
 * than in the voice module means the provider-swapping property of this file
 * still holds: any OpenAI-compatible endpoint with audio support works.
 */
export async function completeAudioJson<T>(
  options: CompleteOptions & {
    schema: ZodType<T>;
    schemaName: string;
    audioBase64: string;
    audioFormat: "mp3" | "wav";
  }
): Promise<T> {
  const { client, config } = getClient();
  const jsonSchema = toStrictJsonSchema(options.schema);

  const response = await withRetry(() =>
    client.chat.completions.create({
      model: config.model,
      temperature: options.temperature ?? 0,
      messages: [
        { role: "system", content: options.system },
        {
          role: "user",
          content: [
            { type: "text", text: options.user },
            {
              type: "input_audio",
              input_audio: {
                data: options.audioBase64,
                format: options.audioFormat,
              },
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: options.schemaName,
          schema: jsonSchema,
          strict: true,
        },
      },
    })
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("The model returned an empty response.");

  const result = options.schema.safeParse(JSON.parse(content));
  if (!result.success) {
    throw new Error(
      "The voice profile did not match the schema:\n" +
        JSON.stringify(result.error.issues, null, 2)
    );
  }
  return result.data;
}

/** Plain text completion, used by the Phase 4 prompt generator. */
export async function completeText(options: CompleteOptions): Promise<string> {
  const { client, config } = getClient();

  const response = await withRetry(() =>
    client.chat.completions.create({
      model: config.model,
      temperature: options.temperature ?? 0.3,
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.user },
      ],
    })
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("The model returned an empty response.");
  return content.trim();
}
