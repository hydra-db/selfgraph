## Summary

Reject ':' in `entity_id` and `entityId` types before deriving an ID. Reuse the same guard in entity writes, with `invalid_argument` and field `type` in both SDKs.

Validation: 36 Python tests and 41 TypeScript tests, including conformance, pass. Precheck, Ruff, Biome, typecheck, and build pass.

## Linked issue

Closes #323

## AI Assistance

| Model | Effort |
|-------|--------|
| GPT-6.1 Sol | High |

## Checklist

- [x] Implements an issue a maintainer has `/approved`.
- [x] Small and scoped to that issue.
- [x] New errors have a code and hint, the same on API, CLI, and MCP in both SDKs.
- [x] Breaking changes described below, or none.

### Breaking changes

The ID helpers now reject types containing ':'.

<!-- codesmith:footer -->
---
<a href="https://dashboardbackend.blacksmith.sh/track/run-proof?expires=1797812795&installation_model_id=440871&pr_number=420&ref=codesmith_pr_footer&repository=hydra-db%2Fselfgraph&return_to=https%3A%2F%2Fgithub.com%2Fhydra-db%2Fselfgraph%2Fpull%2F420&variant=prove_it_works&signature=8833ffed2449d34106c02bc99261b68928f3aea3b10754515acccea205017e80"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/proof-prove-it-works-v2-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/proof-prove-it-works-v2-light.svg"><img alt="Prove it works" src="https://pr-comments-assets.blacksmith.sh/codesmith/proof-prove-it-works-v2-dark-3x.png" width="129" height="28"></picture></a>
<sup><a href="https://app.blacksmith.sh/hydra-db/codesmith/selfgraph/pr/420?autoLogin=true&ref=codesmith_pr_footer">Open in [code]smith</a> · Need help on this PR? Tag <code>@codesmith-bot</code> with what you need.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->
