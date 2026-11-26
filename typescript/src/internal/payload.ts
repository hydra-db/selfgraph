/**
 * Contain stored content before admitting it to an LLM prompt's SDK-owned structure.
 *
 * @param text (string): a source passage or assembled graph record, never its trust header.
 * @param source (boolean): preserve passage lines and label each as source data.
 * @return (string): display-safe content with no unlabelled physical lines.
 */
export function contextPayload(text: string, source = false): string {
  const normalized = text.replaceAll("\r\n", "\n");
  const rows: string[] = [""];
  for (const c of normalized) {
    const n = c.codePointAt(0)!;
    if ([10, 13, 11, 12, 28, 29, 30, 133, 8232, 8233].includes(n)) {
      rows.push("");
    } else {
      const control =
        (n < 32 && n !== 9) ||
        (n >= 127 && n <= 159) ||
        [0x061c, 0x200e, 0x200f].includes(n) ||
        (n >= 0x202a && n <= 0x202e) ||
        (n >= 0x2066 && n <= 0x2069);
      rows[rows.length - 1] += control ? `\\u${n.toString(16).padStart(4, "0")}` : c;
    }
  }
  return source ? rows.map((row) => `SOURCE | ${row}`).join("\n") : rows.join("\\n");
}
