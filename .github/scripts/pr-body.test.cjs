const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const validate = require("./pr-body.cjs");
const template = readFileSync(join(__dirname, "../pull_request_template.md"), "utf8");
const body = template
  .replace(
    "## Summary\n\n",
    "## Summary\n\nReject colons before deriving entity IDs.\nUse the same validation in entity writes.\n",
  )
  .replace("### Validation\n\n", "### Validation\n\nID regressions and conformance pass.\n")
  .replace("Closes #\n", "Closes #323\n")
  .replace("## AI Assistance\n\n", "## AI Assistance\n\nNone.\n")
  .replaceAll("- [ ] ", "- [x] ");

test("accepts a concise description with collapsed details", () => assert.deepEqual(validate(body), []));
test("accepts a filled AI disclosure table", () => {
  assert.deepEqual(
    validate(
      body.replace(
        "## AI Assistance\n\nNone.",
        "## AI Assistance\n\n| Model | Effort |\n|---|---|\n| GPT-6.1 Sol | High |",
      ),
    ),
    [],
  );
});
test("rejects the previous description of PR 420", () => {
  assert.ok(validate(readFileSync(join(__dirname, "fixtures/pr-420-before.md"), "utf8")).length);
});
test("rejects an unfilled template", () => assert.ok(validate(template).length));
for (const [name, change] of [
  ["one-line summary", (text) => text.replace("Use the same validation in entity writes.\n", "")],
  [
    "four-line summary",
    (text) =>
      text.replace(
        "Use the same validation in entity writes.",
        "Use the same validation in entity writes.\nExtra line.\nAnother line.",
      ),
  ],
  ["long summary", (text) => text.replace("Reject colons before deriving entity IDs.", "x".repeat(401))],
  ["expanded details", (text) => text.replace("<details>", "<details open>")],
  ["missing decisions", (text) => text.replace("### Decisions\n\nNone.\n\n", "")],
  ["empty validation", (text) => text.replace("ID regressions and conformance pass.", "")],
  ["missing AI disclosure", (text) => text.replace("## AI Assistance\n\nNone.", "## AI Assistance")],
  [
    "empty AI table",
    (text) => text.replace("## AI Assistance\n\nNone.", "## AI Assistance\n\n| Model | Effort |\n|---|---|"),
  ],
  ["unchecked checklist", (text) => text.replace("- [x] ", "- [ ] ")],
  ["several issues", (text) => text.replace("Closes #323", "Closes #323, #324")],
  ["details outside collapse", (text) => text.replace("</details>", "</details>\nExtra prose.")],
  [
    "hidden section",
    (text) =>
      text.replace(
        "### Validation\n\nID regressions and conformance pass.",
        "<!-- ### Validation\n\nID regressions and conformance pass. -->",
      ),
  ],
]) {
  test(`rejects ${name}`, () => assert.ok(validate(change(body)).length));
}

const workflow = readFileSync(join(__dirname, "../workflows/pr-gate.yml"), "utf8");
const script = workflow
  .split("          script: |\n")[1]
  .split("\n")
  .map((line) => line.slice(12))
  .join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Drive the gate with fake GitHub responses. @param options (object): author and body. @return (Promise<string[]>): failures. */
async function gate({ login = "outsider", permission = "none", type = "User", labels = [], description = body } = {}) {
  const failures = [];
  const github = {
    rest: {
      repos: {
        getContent: async () => ({
          data: {
            content: Buffer.from(JSON.stringify({ maintainers: ["rostered"] })).toString("base64"),
          },
        }),
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
      },
      issues: {
        get: async () => ({
          data: { labels: [{ name: "approved-for-pr" }], user: { login } },
        }),
        createComment: async () => {},
      },
      pulls: {
        update: async () => {
          throw new Error("An approved issue should not close the PR");
        },
      },
    },
  };
  const context = {
    repo: { owner: "hydra-db", repo: "selfgraph" },
    payload: {
      action: "opened",
      repository: { default_branch: "main" },
      pull_request: {
        user: { login, type },
        number: 420,
        body: description,
        labels,
        created_at: "2026-11-21T00:00:00Z",
      },
    },
  };
  const core = {
    info: () => {},
    warning: () => {},
    setFailed: (message) => failures.push(message),
  };
  await new AsyncFunction("github", "context", "core", "process", "require", script)(
    github,
    context,
    core,
    { env: { GITHUB_WORKSPACE: join(__dirname, "../..") } },
    require,
  );
  return failures;
}

const legacy = readFileSync(join(__dirname, "fixtures/pr-420-before.md"), "utf8");
test("the gate rejects an external contributor's old format", async () =>
  assert.ok((await gate({ description: legacy })).length));
test("the gate accepts an external contributor's template", async () => assert.deepEqual(await gate(), []));
for (const [name, options] of [
  ["roster maintainers", { login: "rostered" }],
  ["write-access maintainers", { permission: "write" }],
  ["bots", { type: "Bot" }],
  ["maintainer overrides", { labels: [{ name: "gate-override" }] }],
]) {
  test(`the gate preserves the exemption for ${name}`, async () =>
    assert.deepEqual(await gate({ ...options, description: legacy }), []));
}
test("the privileged gate checks out only the default branch", () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});

test("accepts Windows line endings", () => assert.deepEqual(validate(body.replaceAll("\n", "\r\n")), []));
