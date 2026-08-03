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
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // Double-quoted: strip quotes, keep everything else verbatim.
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // Single-quoted: same.
      value = value.slice(1, -1);
    } else {
      // Unquoted: strip inline comment ` # ...` and trailing whitespace.
      const commentIdx = value.indexOf(' #');
      if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
    }

    if (key && target[key] === undefined) target[key] = value;
  }
  return target;
}
