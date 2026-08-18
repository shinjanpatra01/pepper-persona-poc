import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZodType } from "zod";

/**
 * Write a JSON artifact to disk, creating parent directories as needed.
 *
 * Every pipeline stage writes its output through here so that all artifacts
 * are formatted identically and are easy to diff between recordings
 * (PRD 6: "make every intermediate artifact inspectable").
 */
export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/**
 * Read a JSON artifact and validate it against a Zod schema.
 *
 * This is the guard rail between stages: if you hand-edit transcript.json and
 * typo a speaker label, you find out here with a precise error rather than
 * three stages later with a nonsense persona.
 */
export async function readJson<T>(path: string, schema: ZodType<T>): Promise<T> {
  const raw = await readFile(path, "utf8");
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${path} does not match the expected schema:\n` +
        JSON.stringify(parsed.error.issues, null, 2)
    );
  }
  return parsed.data;
}
