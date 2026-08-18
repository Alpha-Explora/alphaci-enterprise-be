/**
 * Shapes for the read-only GitHub views behind a project's workspace tabs —
 * Code, Pull requests and Pipeline runs.
 *
 * Deliberately narrower than GitHub's own payloads. Each call strips the
 * response down to what a screen renders, so a change in GitHub's API surface
 * touches one mapper here rather than every component that reads it, and so a
 * private repository's full metadata is never proxied to a browser wholesale.
 */

export interface GitHubBranchSummary {
  name: string;
  protected: boolean;
  commitSha: string;
}

export type GitHubContentEntryType = 'file' | 'dir' | 'symlink' | 'submodule';

export interface GitHubContentEntry {
  name: string;
  path: string;
  type: GitHubContentEntryType;
  size: number;
  sha: string;
}

/**
 * One directory listing, or one file.
 *
 * `entries` and `file` are mutually exclusive: GitHub's contents API returns an
 * array for a directory and an object for a file, and the caller cannot know
 * which it asked for until the answer arrives. Modelling both in one response
 * means the browser makes one request per click rather than guessing first.
 */
export interface GitHubContentListing {
  path: string;
  ref: string;
  entries: GitHubContentEntry[];
  file: GitHubFileContent | null;
}

export interface GitHubFileContent {
  name: string;
  path: string;
  size: number;
  sha: string;
  /** UTF-8 text, or null when the blob is binary or over the size cap. */
  content: string | null;
  /** True when content was withheld because the file is binary or too large. */
  truncated: boolean;
  htmlUrl: string | null;
}

export interface GitHubWorkflowRunSummary {
  id: number;
  name: string;
  displayTitle: string;
  headBranch: string;
  headSha: string;
  event: string;
  status: string;
  conclusion: string | null;
  runNumber: number;
  runAttempt: number;
  htmlUrl: string;
  actor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubRunStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitHubRunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
  steps: GitHubRunStep[];
}

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  htmlUrl: string;
  headRef: string;
  baseRef: string;
  author: string | null;
  authorAvatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

export interface GitHubPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** The unified diff. Null for binary files and very large patches. */
  patch: string | null;
}
