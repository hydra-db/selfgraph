const validatePrDescription = require("./pr-description.cjs");

const OVERRIDE = "gate-override";
const GATE_START = new Date("2026-10-08T11:57:53Z");
const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+#(\d+)/gi;

/** Run the contributor gate on the pull request of a pull_request_target event.
 * @param api (object): the github, context and core objects of actions/github-script.
 * @return (Promise<void>): nothing; the run is failed and the PR commented on when the gate is not met.
 */
module.exports = async ({ github, context, core }) => {
  const pr = context.payload.pull_request;
  const author = pr.user.login;
  const number = pr.number;
  const body = pr.body || "";
  const { owner, repo } = context.repo;

  /** Comment on the pull request.
   * @param message (string): the comment text.
   * @return (Promise<unknown>): the API response.
   */
  const reply = (message) => github.rest.issues.createComment({ owner, repo, issue_number: number, body: message });

  let roster = { maintainers: [] };
  try {
    const got = await github.rest.repos.getContent({
      owner,
      repo,
      path: ".github/vouched.json",
      ref: context.payload.repository.default_branch,
    });
    roster = JSON.parse(Buffer.from(got.data.content, "base64").toString("utf8"));
  } catch (e) {
    core.warning(`Could not read vouched.json, treating roster as empty: ${e.message}`);
  }

  /** Tell whether a person is a maintainer: on the roster, or with write access to the repository.
   * @param login (string): the GitHub login.
   * @return (Promise<boolean>): true for a maintainer.
   */
  const isTeam = async (login) =>
    (roster.maintainers || []).includes(login) ||
    ["admin", "write"].includes(
      await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login }).then(
        (r) => r.data.permission,
        () => "none",
      ),
    );

  if (pr.user.type === "Bot") {
    core.info("Bot PR, exempt.");
    return;
  }
  if (new Date(pr.created_at) < GATE_START) {
    core.info("Opened before the gate, exempt.");
    return;
  }
  if ((pr.labels || []).some((l) => l.name === OVERRIDE)) {
    core.info(`Has ${OVERRIDE}, exempt.`);
    return;
  }
  if (context.payload.action === "reopened" && (await isTeam(context.payload.sender.login))) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [OVERRIDE] });
    core.info(`Reopened by a maintainer, labelled ${OVERRIDE}.`);
    return;
  }
  const isMaintainer = await isTeam(author);

  const problems = [];
  const refs = [...body.matchAll(CLOSING_REFERENCE)].map((x) => parseInt(x[1], 10));
  let hasApproved = false;
  let notAssigned = null;
  for (const n of refs) {
    try {
      const iss = await github.rest.issues.get({ owner, repo, issue_number: n });
      if (iss.data.pull_request) continue;
      if (!(iss.data.labels || []).some((l) => (l.name || l) === "approved-for-pr")) continue;
      if (iss.data.user?.login === author || (iss.data.assignees || []).some((a) => a.login === author)) {
        hasApproved = true;
        break;
      }
      notAssigned = n;
    } catch (e) {}
  }
  if (!hasApproved && !isMaintainer) {
    const why = notAssigned
      ? `Issue #${notAssigned} is approved, but you are not assigned to it. Comment \`/take\` on the issue to be assigned. Then reopen this PR.`
      : `This PR has no linked **approved** issue. Open an issue, get it discussed and \`/approved\` by a maintainer, then link it here with \`Closes #N\`. Closing for now; reopen once linked.`;
    await reply(
      `${why} (Fastest help: the #pr-discussion channel on Discord.)\n\nMaintainers: reopen this PR to override the gate (it gets the \`${OVERRIDE}\` label).`,
    );
    await github.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" });
    core.setFailed("No linked approved issue.");
    return;
  }
  if (!isMaintainer) {
    problems.push(...validatePrDescription(body));
  }
  if (!/##\s*AI assistance/i.test(body)) {
    problems.push(
      "The **AI assistance** section is missing from the PR description. Restore it from the PR template and disclose whether AI tools were used.",
    );
  }

  if (problems.length) {
    await reply(problems.join("\n\n"));
    core.setFailed("PR template requirements not met.");
    return;
  }
  core.info("PR gate passed.");
};
