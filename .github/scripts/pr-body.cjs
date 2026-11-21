const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const template = readFileSync(join(__dirname, "../pull_request_template.md"), "utf8");
const required = sections(template)
  .slice(1)
  .map(({ name }) => name);
const checklist = template
  .split("\n")
  .filter((line) => line.startsWith("- [ ] "))
  .map((line) => line.slice(6));

/** Read Markdown sections. @param text (string): Markdown. @return (object[]): headings and contents. */
function sections(text) {
  const headings = [...text.matchAll(/^#{2,3} (.+)\r?$/gm)];
  return headings.map((heading, index) => ({
    name: heading[1].trim(),
    content: text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length).trim(),
  }));
}

/** Check a PR description against the template. @param body (string): description. @return (string[]): problems. */
function validatePrBody(body) {
  const text = body
    .replaceAll("\r\n", "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const details = text.match(
    /^## Summary\s*\n([\s\S]*?)<details>\s*<summary>Implementation details<\/summary>([\s\S]*?)<\/details>\s*$/i,
  );
  if (!details || (text.match(/<\/?details\b[^>]*>/gi) || []).length !== 2) {
    return [
      "Use .github/pull_request_template.md: a Summary followed by one closed Implementation details block, with nothing after it.",
    ];
  }
  const problems = [];
  const summary = details[1]
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    summary.length < 2 ||
    summary.length > 3 ||
    summary.join(" ").length > 400 ||
    summary.some((line) => /^(?:#|```|<)/.test(line))
  ) {
    problems.push("Write the Summary in two or three nonempty lines, at most 400 characters total.");
  }
  const parsed = sections(details[2]);
  if (JSON.stringify(parsed.map(({ name }) => name)) !== JSON.stringify(required)) {
    problems.push("Keep every section inside Implementation details, in the order shown in the PR template.");
    return problems;
  }
  for (const { name, content } of parsed) {
    if (!content) problems.push(`Fill in ${name}; use None. when it does not apply.`);
  }
  const values = Object.fromEntries(parsed.map(({ name, content }) => [name, content]));
  if (!/^Closes #[1-9]\d*\.?$/.test(values["Linked issue"])) {
    problems.push("Link exactly one issue under Linked issue with Closes #123.");
  }
  const ai = values["AI Assistance"];
  const rows = ai
    .split("\n")
    .filter((line) => /^\s*\|/.test(line))
    .map((line) =>
      line
        .trim()
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  if (
    !/^None\.?$/i.test(ai) &&
    !(
      rows.length >= 3 &&
      rows[0][0] === "Model" &&
      rows[0][1] === "Effort" &&
      rows.slice(2).every((row) => row.length === 2 && row.every(Boolean))
    )
  ) {
    problems.push("Disclose AI Assistance as None. or a Model/Effort table with at least one filled row.");
  }
  const checked = values.Checklist.split("\n")
    .filter((line) => /^- \[x\] /i.test(line))
    .map((line) => line.slice(6));
  if (JSON.stringify(checked) !== JSON.stringify(checklist)) {
    problems.push("Keep and complete the four checklist items from the PR template.");
  }
  return problems;
}

module.exports = validatePrBody;
