const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const gate = require("./pr-gate.cjs");
const validate = require("./pr-description.cjs");

const template = readFileSync(join(__dirname, "../pull_request_template.md"), "utf8").replaceAll("\r\n", "\n");
const workflow = readFileSync(join(__dirname, "../workflows/pr-gate.yml"), "utf8");

const SUMMARY = "Reject colons in entity types before the id is derived.\nEntity writes use the same guard.";
const FILLED = template
  .replace(
    "<!-- Two or three nonempty lines, at most 400 characters in all. Everything else goes in the block below. -->",
    SUMMARY,
  )
  .replace("### Validation\n", "### Validation\n\nID regressions and conformance pass.\n")
  .replace("Closes #\n", "Closes #323\n");

const LEGACY = [
  "## Summary",
  "",
  "Reject ':' in entity types before deriving an id. Reuse the guard in entity writes.",
  "",
  "Validation: 36 python tests and 41 typescript tests pass.",
  "",
  "## Linked issue",
  "",
  "Closes #323",
  "",
  "## AI Assistance",
  "",
  "| Model | Effort |",
  "|-------|--------|",
  "| GPT-6 Astra | High |",
  "",
  "## Checklist",
  "",
  "- [x] Implements an issue a maintainer has `/approved`.",
  "",
  "### Breaking changes",
  "",
  "None.",
].join("\n");

const FOOTER = "\n\n<!-- codesmith:footer -->\n---\n<sup>Open in codesmith</sup>\n<!-- /codesmith:footer -->";

test("accepts the template once its blanks are filled", () => assert.deepEqual(validate(FILLED), []));

test("rejects the template as it ships", () => assert.ok(validate(template).length > 0));

test("rejects the description format that predates the template", () => assert.ok(validate(LEGACY).length > 0));

test("accepts Windows line endings", () => assert.deepEqual(validate(FILLED.replaceAll("\n", "\r\n")), []));

test("accepts a bot footer after the collapsed block", () => assert.deepEqual(validate(FILLED + FOOTER), []));

test("accepts a three line summary at the character limit", () => {
  const edge = ["a".repeat(100), "b".repeat(100), "c".repeat(198)].join("\n");
  assert.equal(edge.length, 400);
  assert.deepEqual(validate(FILLED.replace(SUMMARY, edge)), []);
});

test("counts characters, not UTF-16 units, in the summary", () => {
  const emoji = ["\u{1F600}".repeat(150), "\u{1F600}".repeat(124)].join("\n");
  assert.deepEqual(validate(FILLED.replace(SUMMARY, emoji)), []);
});

test("accepts nested details, extra headings and None. answers", () => {
  const body = FILLED.replace(
    "ID regressions and conformance pass.",
    "ID regressions and conformance pass.\n\n#### Notes\n\n<details>\n<summary>log</summary>\n\nok\n\n</details>",
  );
  assert.deepEqual(validate(body), []);
});

test("accepts summary lines that start with an issue number or a comparison", () => {
  assert.deepEqual(
    validate(FILLED.replace(SUMMARY, "#323 asked for a short description.\n<5% overhead on insert.")),
    [],
  );
});

test("accepts section titles in any letter case", () => {
  assert.deepEqual(validate(FILLED.replace("### AI Assistance", "### AI assistance")), []);
});

test("ignores headings inside code fences", () => {
  const fenced = "ID regressions and conformance pass.\n\n```md\n### Limits\n\nNone.\n```";
  assert.deepEqual(validate(FILLED.replace("ID regressions and conformance pass.", fenced)), []);
});

test("reports an empty section even when another heading follows it", () => {
  const problems = validate(FILLED.replace("ID regressions and conformance pass.\n", "### Notes\n\nlater\n"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Fill in Validation/);
});

for (const [name, change] of [
  ["a one line summary", (text) => text.replace(SUMMARY, "Reject colons in entity types.")],
  ["a four line summary", (text) => text.replace(SUMMARY, `${SUMMARY}\nThird.\nFourth.`)],
  ["a summary over 400 characters", (text) => text.replace(SUMMARY, `${"a".repeat(200)}\n${"b".repeat(201)}`)],
  ["a summary that carries a heading", (text) => text.replace(SUMMARY, `First line.\n### Validation`)],
  ["a summary that opens a tag", (text) => text.replace(SUMMARY, "First line.\n<details>")],
  ["a summary that opens a tilde fence", (text) => text.replace(SUMMARY, "First line.\n~~~js")],
  ["visible text after the block", (text) => `${text}\n\n## Full write-up\n\nLong prose.`],
  ["an expanded details block", (text) => text.replace("<details>", "<details open>")],
  ["no details block", (text) => text.replace("<details>", "").replace("</details>", "")],
  ["text before the summary", (text) => `Intro.\n\n${text}`],
  ["a missing section", (text) => text.replace("### Limits\n\nNone.\n\n", "")],
  ["a repeated section", (text) => text.replace("### Limits", "### Limits\n\nNone.\n\n### Limits")],
  ["sections out of order", (text) => text.replace("### Decisions", "### Limits\n\nNone.\n\n### Decisions")],
  ["an empty validation", (text) => text.replace("ID regressions and conformance pass.", "")],
  ["an empty limits", (text) => text.replace("### Limits\n\nNone.", "### Limits")],
  [
    "a section moved after the block",
    (text) =>
      text.replace("### Breaking changes\n\nNone.\n\n</details>", "</details>\n\n### Breaking changes\n\nNone."),
  ],
  [
    "a section hidden in a comment",
    (text) =>
      text.replace(
        "### Validation\n\nID regressions and conformance pass.",
        "<!-- ### Validation\n\nID regressions and conformance pass. -->",
      ),
  ],
]) {
  test(`rejects ${name}`, () => assert.ok(validate(change(FILLED)).length > 0));
}

/** Drive the gate with fake GitHub responses.
 * @param options (object): the author, description and event to simulate.
 * @return (Promise<object>): the failures, comments, closed pull requests and added labels.
 */
const run = async ({
  login = "outsider",
  permission = "none",
  type = "User",
  labels = [],
  body = FILLED,
  action = "opened",
  sender = login,
  approved = true,
  createdAt = "2026-11-21T00:00:00Z",
} = {}) => {
  const seen = { failures: [], comments: [], closed: [], labels: [] };
  const github = {
    rest: {
      repos: {
        getContent: async () => ({
          data: { content: Buffer.from(JSON.stringify({ maintainers: ["rostered"] })).toString("base64") },
        }),
        getCollaboratorPermissionLevel: async ({ username }) => ({
          data: { permission: username === "writer" ? "write" : permission },
        }),
      },
      issues: {
        get: async () => ({
          data: { labels: approved ? [{ name: "approved-for-pr" }] : [], user: { login }, assignees: [] },
        }),
        createComment: async ({ body: text }) => seen.comments.push(text),
        addLabels: async ({ labels: added }) => seen.labels.push(...added),
      },
      pulls: { update: async ({ state }) => seen.closed.push(state) },
    },
  };
  const context = {
    repo: { owner: "hydra-db", repo: "selfgraph" },
    payload: {
      action,
      sender: { login: sender },
      repository: { default_branch: "main" },
      pull_request: { user: { login, type }, number: 7, body, labels, created_at: createdAt },
    },
  };
  const core = { info: () => {}, warning: () => {}, setFailed: (message) => seen.failures.push(message) };
  await gate({ github, context, core });
  return seen;
};

test("the gate passes an external contributor who follows the template", async () => {
  const seen = await run();
  assert.deepEqual(seen, { failures: [], comments: [], closed: [], labels: [] });
});

test("the gate fails an external contributor on the old format and says what to fix", async () => {
  const seen = await run({ body: LEGACY });
  assert.deepEqual(seen.failures, ["PR template requirements not met."]);
  assert.equal(seen.comments.length, 1);
  assert.match(seen.comments[0], /collapsed/);
  assert.deepEqual(seen.closed, []);
});

test("the gate still requires the AI assistance section", async () => {
  const seen = await run({ body: FILLED.replace("### AI Assistance", "### Models") });
  assert.deepEqual(seen.failures, ["PR template requirements not met."]);
  assert.match(seen.comments.join("\n"), /AI assistance/);
});

test("the gate still closes a PR without an approved issue", async () => {
  const seen = await run({ approved: false });
  assert.deepEqual(seen.closed, ["closed"]);
  assert.deepEqual(seen.failures, ["No linked approved issue."]);
});

for (const [name, options, labelled] of [
  ["roster maintainers", { login: "rostered" }, []],
  ["write access maintainers", { login: "writer" }, []],
  ["admin maintainers", { permission: "admin" }, []],
  ["bots", { type: "Bot" }, []],
  ["PRs with the override label", { labels: [{ name: "gate-override" }] }, []],
  ["PRs opened before the gate", { createdAt: "2026-10-01T00:00:00Z" }, []],
  ["PRs a maintainer reopens", { action: "reopened", sender: "rostered" }, ["gate-override"]],
]) {
  test(`the gate keeps the exemption for ${name}`, async () => {
    const seen = await run({ ...options, body: LEGACY });
    assert.deepEqual(seen.failures, []);
    assert.deepEqual(seen.comments, []);
    assert.deepEqual(seen.labels, labelled);
  });
}

test("the gate does not exempt a reopen by the author", async () => {
  const seen = await run({ action: "reopened", body: LEGACY });
  assert.deepEqual(seen.failures, ["PR template requirements not met."]);
});

test("the privileged workflow loads its code from the default branch only", () => {
  const steps = workflow.split("      - uses:");
  assert.match(steps[1], /actions\/checkout@v4/);
  assert.match(steps[1], /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(steps[1], /persist-credentials: false/);
  assert.match(steps[2], /actions\/github-script@v7/);
  assert.match(steps[2], /\.github\/scripts\/pr-gate\.cjs/);
});
