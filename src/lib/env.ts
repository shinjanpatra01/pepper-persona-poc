import "dotenv/config";

/**
 * Read a required environment variable, failing loudly and early.
 *
 * Why this exists: without it, a missing key surfaces later as a confusing
 * 401 from Deepgram/OpenAI/Vapi. Here you get the variable name and the file
 * you need to put it in.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Add it to your .env file ` +
        `(copy .env.example to .env if you have not yet).`
    );
  }
  return value.trim();
}

/** Read an optional environment variable with a fallback default. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}
