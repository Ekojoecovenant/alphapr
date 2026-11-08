/** Pull-request actions that trigger (or re-trigger) a review. */
export type ReviewAction = 'opened' | 'synchronize' | 'ready_for_review';

export interface ReviewJob {
	installationId: number;
	owner: string;
	repo: string;
	repoFullName: string;
	prNumber: number;
	headSha: string;
	action: ReviewAction;
	statusCommentId: number | null;
	checkRunId: number | null;
}

export type CheckConclusion = 'success' | 'neutral' | 'action_required' | 'failure';

export interface ReviewCommentInput {
	path: string;
	line: number;
	side: 'RIGHT';
	start_line?: number;
	start_side?: 'RIGHT';
	body: string;
}

export interface OtherCheckRun {
	name: string;
	conclusion: string | null;
	summary: string | null;
	text: string | null;
}
