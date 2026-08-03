// ============================================================================
// src/quota/dotenv-parse.ts
// Minimal .env parser matching dotenv semantics (review P2).
// Handles quoted values, inline comments, and trailing whitespace — the
// hand-written regex in smoke couldn't.
// ============================================================================

/**
 * Parse .env file content into a key→value map. Rules (consistent with dotenv):
 *   - Blank lines and lines starting with # are skipped.
 *   - `KEY=VALUE` splits on the first `=`.
 *   - Unquoted values: inline ` # comment` and trailing whitespace are stripped.
 *   - Single/double-quoted values: quotes removed, content kept verbatim
 *     (inline `#` inside quotes is literal).
 *   - Existing keys in `target` are NOT overwritten (first-wins, like Next).
 */
export function parseDotenv(
  content: string,
  target: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  for (const line of content.split('\n')) {
    const entry = parseEnvLine(line);
    if (entry && target[entry[0]] === undefined) target[entry[0]] = entry[1];
  }
  return target;
}

/** Parse a single line into [key, value], or null if it should be skipped. */
function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 0) return null;
  const key = trimmed.slice(0, eqIdx).trim();
  if (!key) return null;
  return [key, parseEnvValue(trimmed.slice(eqIdx + 1).trim())];
}

/** Strip quotes / inline comments from a raw value string. */
function parseEnvValue(value: string): string {
  // Quoted (double or single): strip surrounding quotes, keep content verbatim.
  if (isQuoted(value, '"') || isQuoted(value, "'")) {
    return value.slice(1, -1);
  }
  // Unquoted: strip inline comment ` # ...` and trailing whitespace.
  const commentIdx = value.indexOf(' #');
  if (commentIdx >= 0) return value.slice(0, commentIdx).trim();
  return value;
}

/** True if value is wrapped in matching quote chars (length ≥ 2). */
function isQuoted(value: string, quote: string): boolean {
  return value.length >= 2 && value.startsWith(quote) && value.endsWith(quote);
}
