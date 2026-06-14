# Changelog

## [0.2.0](https://github.com/four-bytes/four-opencode-supertools/compare/four-opencode-supertools-v0.1.0...four-opencode-supertools-v0.2.0) (2026-06-14)


### Features

* add gh_issue_list, gh_issue_close, gh_pr_status, gh_branch_cleanup, gh_release_info tools [#10](https://github.com/four-bytes/four-opencode-supertools/issues/10) ([#11](https://github.com/four-bytes/four-opencode-supertools/issues/11)) ([56007ad](https://github.com/four-bytes/four-opencode-supertools/commit/56007adffb55e85e0a22e88738f9abd8a1be7267))
* add gh_pr_create and gh_pr_comment tools ([2011693](https://github.com/four-bytes/four-opencode-supertools/commit/201169346db30dc30dc50994ca4ac4fcd848bdba))
* add git intelligence tools (curse_score, bus_factor, coupling, ownership, blast_radius) ([d174f13](https://github.com/four-bytes/four-opencode-supertools/commit/d174f13bbdd02e317ed4a4a70d6d9f0052dcaacb))
* add GitHub ops tools (Wave S5) — 5 gh CLI wrappers, 137 tests pass ([7213dff](https://github.com/four-bytes/four-opencode-supertools/commit/7213dffa6528400c5ee2e5c3a1f8d841eda718b6))
* add GitLab merge request tools — create, comment, status (S8b) ([9bd2e72](https://github.com/four-bytes/four-opencode-supertools/commit/9bd2e7259c5f16a4daf28312442ee266e2924f2b))
* initial release with apply_patch tool [#1](https://github.com/four-bytes/four-opencode-supertools/issues/1) ([1786562](https://github.com/four-bytes/four-opencode-supertools/commit/1786562249d0d79b627b9e5a0ac2f091b1612389))
* merge four-opencode-git-tools analytics into supertools ([#9](https://github.com/four-bytes/four-opencode-supertools/issues/9)) ([b2229e6](https://github.com/four-bytes/four-opencode-supertools/commit/b2229e6bec1a14b7a844036df92514e06982651e))


### Bug Fixes

* align [@typescript-eslint](https://github.com/typescript-eslint) packages to 8.61.0 [#23](https://github.com/four-bytes/four-opencode-supertools/issues/23) ([#24](https://github.com/four-bytes/four-opencode-supertools/issues/24)) ([435ba7d](https://github.com/four-bytes/four-opencode-supertools/commit/435ba7d69badd24222792dc3ad66409aa1467a7c))
* correct after_line=-1 prepend position in append_file [#16](https://github.com/four-bytes/four-opencode-supertools/issues/16) ([#20](https://github.com/four-bytes/four-opencode-supertools/issues/20)) ([e73fe00](https://github.com/four-bytes/four-opencode-supertools/commit/e73fe00340bce31fdeb620a61c13410546899e12))
* include bodyless reviews in gh-pr-review output [#18](https://github.com/four-bytes/four-opencode-supertools/issues/18) ([#19](https://github.com/four-bytes/four-opencode-supertools/issues/19)) ([654cf7f](https://github.com/four-bytes/four-opencode-supertools/commit/654cf7fdc2ca987d0fe884d850eb6f07b37e84c2))


### Documentation

* add git-tools implementation spec ([b26fbd3](https://github.com/four-bytes/four-opencode-supertools/commit/b26fbd37c1edb3f1db46af89ac7acd313eb440a1))
* add git-tools implementation spec for developer handoff ([b3cbcf5](https://github.com/four-bytes/four-opencode-supertools/commit/b3cbcf5ef257c5608b10d146eded978ff3b4cbb9))
* add TUI note + star CTA to README ([bf66afd](https://github.com/four-bytes/four-opencode-supertools/commit/bf66afd791cf4e5631b7bd0c6d00fecdd00d59a0))
* add waves S7-S10 — search/patch, vcs/release, devops, documentation ([899050b](https://github.com/four-bytes/four-opencode-supertools/commit/899050b9ebb9a8842a0ffe90945ad6532cc8c5d5))

## [0.2.0] - 2026-06-10

### Features
- Added `batch_edit` tool — search and replace across multiple files (~80% token savings)
- Added `lint_file` tool — run linter, return errors only (~60% token savings)
- Added `run_tests` tool — run tests, return failures only (~50% token savings)

### Documentation
- Added ROADMAP.md with wave-based evolution plan
- Added CONTRIBUTING.md with full workflow guide
- Added GUIDELINES.md with coding standards
- Added issue templates (bug report, feature request)
- Added PR template
- Added dependabot.yml
- Added CodeQL workflow

## [0.1.0] - 2026-06-10

- Initial release with `apply_patch` tool
