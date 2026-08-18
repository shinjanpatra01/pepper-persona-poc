/**
 * Minimal `--flag=value` / `--flag` command line parser.
 *
 * Deliberately dependency-free and about 20 lines: the POC only needs a couple
 * of flags per script, and a real CLI framework would be more setup than the
 * pipeline stages themselves.
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [name, ...rest] = arg.slice(2).split("=");
      flags[name!] = rest.length > 0 ? rest.join("=") : true;
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

/** Read a flag as a string, or undefined when absent / passed with no value. */
export function flagString(
  flags: ParsedArgs["flags"],
  name: string
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Read a flag as a number, erroring on a non-numeric value. */
export function flagNumber(
  flags: ParsedArgs["flags"],
  name: string
): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`--${name} expects a number, received "${value}".`);
  }
  return parsed;
}
