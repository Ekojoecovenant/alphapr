export interface ReviewJob {
  installationId: number;
  owner: string;
  repo: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  action: "opened" | "synchronize";
  statusCommentId: number | null;
  checkRunId: number | null;
}

export type CheckConclusion = "success" | "neutral" | "action_required" | "failure";

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface OtherCheckRun {
  name: string;
  conclusion: string | null;
  summary: string | null;
  text: string | null;
}
