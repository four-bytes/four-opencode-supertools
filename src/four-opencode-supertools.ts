// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { Plugin } from '@opencode-ai/plugin';
import { applyPatchTool } from './tools/apply-patch';
import { batchEditTool } from './tools/batch-edit';
import { lintFileTool } from './tools/lint-file';
import { runTestsTool } from './tools/run-tests';
import { curseScoreTool } from './tools/curse-score';
import { busFactorTool } from './tools/bus-factor';
import { implicitCouplingTool } from './tools/implicit-coupling';
import { ownershipTool } from './tools/ownership';
import { blastRadiusTool } from './tools/blast-radius';
import { gitDiffTool } from './tools/git-diff';
import { trendTool } from './tools/trend';
import { prRiskTool } from './tools/pr-risk';
import { ghIssueListTool } from './tools/gh-issue-list';
import { ghIssueCloseTool } from './tools/gh-issue-close';
import { ghPrStatusTool } from './tools/gh-pr-status';
import { ghBranchCleanupTool } from './tools/gh-branch-cleanup';
import { ghReleaseInfoTool } from './tools/gh-release-info';
import { gitLogStructuredTool } from './tools/git-log-structured';
import { gitlabMrCreateTool } from './tools/gitlab-mr-create';
import { gitlabMrCommentTool } from './tools/gitlab-mr-comment';
import { gitlabMrStatusTool } from './tools/gitlab-mr-status';
import { ghPrCreateTool } from './tools/gh-pr-create';
import { ghPrCommentTool } from './tools/gh-pr-comment';
import { ghPrReviewTool } from './tools/gh-pr-review';
import { appendFileTool } from './tools/append-file';
import { ghBotReviewTool } from './tools/gh-bot-review';

const FourOpencodeSupertools: Plugin = async (_ctx) => {
  return {
    tool: {
      patch_file: applyPatchTool,
      batch_edit: batchEditTool,
      lint_file: lintFileTool,
      run_tests: runTestsTool,
      curse_score: curseScoreTool,
      bus_factor: busFactorTool,
      implicit_coupling: implicitCouplingTool,
      ownership: ownershipTool,
      blast_radius: blastRadiusTool,
      git_diff: gitDiffTool,
      trend: trendTool,
      pr_risk: prRiskTool,
      gh_issue_list: ghIssueListTool,
      gh_issue_close: ghIssueCloseTool,
      gh_pr_status: ghPrStatusTool,
      gh_branch_cleanup: ghBranchCleanupTool,
      gh_release_info: ghReleaseInfoTool,
      git_log_structured: gitLogStructuredTool,
      gitlab_mr_create: gitlabMrCreateTool,
      gitlab_mr_comment: gitlabMrCommentTool,
      gitlab_mr_status: gitlabMrStatusTool,
      gh_pr_create: ghPrCreateTool,
      gh_pr_comment: ghPrCommentTool,
      gh_pr_review: ghPrReviewTool,
      append_file: appendFileTool,
      gh_bot_review: ghBotReviewTool,
    },
  };
};

export default FourOpencodeSupertools;
