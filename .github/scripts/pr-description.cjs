const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SUMMARY_MIN_LINES = 2;
const SUMMARY_MAX_LINES = 3;
const SUMMARY_MAX_CHARS = 400;
const SECTION_HEADING = /^### (.+?)[ \t]*$/gm;
const DESCRIPTION = /^## Summary[ \t]*\n([\s\S]*?)<details>\s*<summary>[\s\S]*?<\/summary>([\s\S]*)<\/details>$/;
const BOT_FOOTER = /<!--\s*([\w-]+):footer\s*-->[\s\S]*?<!--\s*\/\1:footer\s*-->/g;
const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const BLOCK_START = /^(?:#{1,6}(?:\s|$)|```|~~~|<[A-Za-z/!])/;

/** Normalize line endings and drop what GitHub does not show or a bot appends: HTML comments and bot footers.
 * @param text (string): a Markdown description.
 * @return (string): the visible text, trimmed.
 */
const visible = (text) =>
  text
    .replaceAll("\r\n", "\n")
    .replace(BOT_FOOTER, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

/** List the level-3 headings of a Markdown block outside code fences, with the offsets of each heading line.
 * @param text (string): the block.
 * @return (object[]): the title, the lowercased name, and the start and end of each heading.
 */
const headings = (text) => {
  const unfenced = text.replace(FENCE, (fence) => fence.replace(/[^\n]/g, " "));
  return [...unfenced.matchAll(SECTION_HEADING)].map((match) => ({
    title: match[1],
    name: match[1].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
};

const REQUIRED = headings(visible(readFileSync(join(__dirname, "../pull_request_template.md"), "utf8")));
const REQUIRED_NAMES = REQUIRED.map(({ name }) => name);

/** Check the visible summary of a description.
 * @param summary (string): the text between the Summary heading and the collapsed block.
 * @return (string[]): the problems found.
 */
const summaryProblems = (summary) => {
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const ok =
    lines.length >= SUMMARY_MIN_LINES &&
    lines.length <= SUMMARY_MAX_LINES &&
    Array.from(lines.join("\n")).length <= SUMMARY_MAX_CHARS &&
    !lines.some((line) => BLOCK_START.test(line));
  return ok
    ? []
    : [
        `Write the Summary in ${SUMMARY_MIN_LINES} or ${SUMMARY_MAX_LINES} nonempty lines of plain text, at most ${SUMMARY_MAX_CHARS} characters in all. Put everything else in the Implementation details block.`,
      ];
};

/** Check the sections inside the collapsed block against the PR template.
 * @param inner (string): the text inside the collapsed block.
 * @return (string[]): the problems found.
 */
const sectionProblems = (inner) => {
  const all = headings(inner);
  const found = all.filter(({ name }) => REQUIRED_NAMES.includes(name));
  if (JSON.stringify(found.map(({ name }) => name)) !== JSON.stringify(REQUIRED_NAMES)) {
    return [
      `Keep these sections once each, in this order, inside the Implementation details block: ${REQUIRED.map(({ title }) => title).join(", ")}.`,
    ];
  }
  const empty = found
    .filter((heading) => !inner.slice(heading.end, all[all.indexOf(heading) + 1]?.start).trim())
    .map(({ name }) => REQUIRED[REQUIRED_NAMES.indexOf(name)].title);
  return empty.length ? [`Fill in ${empty.join(", ")}; write None. where a section does not apply.`] : [];
};

/** Check a PR description against .github/pull_request_template.md.
 * @param body (string): the PR description.
 * @return (string[]): the problems found, empty when the description meets the template.
 */
const validatePrDescription = (body) => {
  const match = visible(body).match(DESCRIPTION);
  if (!match) {
    return [
      "Start the description with `## Summary`, followed by one collapsed `<details>` block that holds everything else, as in .github/pull_request_template.md.",
    ];
  }
  return [...summaryProblems(match[1]), ...sectionProblems(match[2])];
};

module.exports = validatePrDescription;
