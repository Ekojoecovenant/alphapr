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

/**
 * Token counts for a single model call, normalized across providers.
 *
 * Either side may be null: providers report usage differently (chat-completions
 * says `prompt_tokens`/`completion_tokens`, Anthropic says
 * `input_tokens`/`output_tokens`) and may omit it entirely.
 */
export interface TokenUsage {
	inputTokens: number | null;
	outputTokens: number | null;
}

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
