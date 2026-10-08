/** Small terminal helpers. No dependencies — this is a reference app, not a framework. */

const ESC = String.fromCharCode(27);

const ansi = (code: string) => (s: string | number) =>
  process.stdout.isTTY ? `${ESC}[${code}m${s}${ESC}[0m` : String(s);

export const bold = ansi("1");
export const dim = ansi("2");
export const red = ansi("31");
export const green = ansi("32");
export const yellow = ansi("33");
export const blue = ansi("36");
export const magenta = ansi("35");

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, "");

/** Parse `--key value` and `--flag` into a map. */
export function parseArgs(
  argv: string[] = process.argv.slice(2),
): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  if (positional.length > 0) out._ = positional.join(" ");
  return out;
}

export function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim("-".repeat(Math.max(text.length, 24)))}`);
}

/** Colour a 0..1 score: 1.0 green, >=0.8 yellow, below that red. */
export function scoreColor(value: number): string {
  const text = value.toFixed(2);
  if (value >= 0.999) return green(text);
  if (value >= 0.8) return yellow(text);
  return red(text);
}

/** Render a simple fixed-width table. */
export function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)),
  );
  const pad = (s: string, w: number) =>
    s + " ".repeat(Math.max(0, w - stripAnsi(s).length));

  console.log(headers.map((h, i) => bold(pad(h, widths[i]!))).join("  "));
  console.log(dim(widths.map((w) => "-".repeat(w)).join("  ")));
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell ?? "", widths[i]!)).join("  "));
  }
}

/** Run a CLI body, flush traces, and exit with a sane code. */
export async function main(fn: () => Promise<number | void>): Promise<void> {
  let code = 0;
  try {
    code = (await fn()) ?? 0;
  } catch (error) {
    console.error(
      `\n${red("FAILED")} ${error instanceof Error ? error.message : String(error)}`,
    );
    if (process.env.DEBUG && error instanceof Error) {
      console.error(dim(error.stack ?? ""));
    }
    code = 1;
  } finally {
    // Span export is batched; without this the traces never leave the process.
    const { shutdownTracing } = await import("../instrumentation.js");
    await shutdownTracing().catch(() => {});
  }
  process.exit(code);
}
