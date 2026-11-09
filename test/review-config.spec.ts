import { describe, expect, it } from 'vitest';
import {
	clearRepoOverride,
	loadRepoConfig,
	mergeRepoConfig,
	normalizeSeverity,
	normalizeTone,
	saveRepoOverride,
	shouldReviewRepo,
	splitIgnorePaths,
} from '../src/review-config';
import { makeFakeDb } from './helpers/fake-d1';

const INSTALLATION = {
	account_login: 'ekojoecovenant',
	api_key_encrypted: 'iv.ciphertext',
	provider: 'openrouter',
	model: 'deepseek/deepseek-v4-flash',
	severity_threshold: 'minor',
	review_tone: 'thorough',
	ignore_paths: 'dist/,*.lock',
};

function seedConfig(overrides: Record<string, unknown> = {}) {
	return makeFakeDb({ installationConfig: { ...INSTALLATION, ...overrides } });
}

describe('normalization', () => {
	it('accepts the three severity values and degrades anything else to all', () => {
		expect(normalizeSeverity('all')).toBe('all');
		expect(normalizeSeverity('MINOR')).toBe('minor');
		expect(normalizeSeverity('major')).toBe('major');
		expect(normalizeSeverity('critical')).toBe('all');
		expect(normalizeSeverity(null)).toBe('all');
		expect(normalizeSeverity(undefined)).toBe('all');
	});

	it('treats only concise as concise', () => {
		expect(normalizeTone('concise')).toBe('concise');
		expect(normalizeTone(' CONCISE ')).toBe('concise');
		expect(normalizeTone('thorough')).toBe('thorough');
		expect(normalizeTone('')).toBe('thorough');
	});

	it('splits ignore paths and drops empties', () => {
		expect(splitIgnorePaths('dist/, *.lock ,,vendor/')).toEqual(['dist/', '*.lock', 'vendor/']);
		expect(splitIgnorePaths('')).toEqual([]);
		expect(splitIgnorePaths(null)).toEqual([]);
	});
});

describe('mergeRepoConfig', () => {
	it('inherits everything when there is no override row', () => {
		const cfg = mergeRepoConfig(INSTALLATION, null);
		expect(cfg).toMatchObject({
			enabled: true,
			provider: 'openrouter',
			model: 'deepseek/deepseek-v4-flash',
			severityThreshold: 'minor',
			reviewTone: 'thorough',
			ignorePaths: ['dist/', '*.lock'],
		});
		expect(Object.values(cfg.inherits).every(Boolean)).toBe(true);
	});

	it('lets a repo override win, per field, and records which fields were overridden', () => {
		const cfg = mergeRepoConfig(INSTALLATION, {
			enabled: 1,
			provider: null,
			model: 'anthropic/claude-sonnet-5',
			severity_threshold: 'major',
			review_tone: 'concise',
			ignore_paths: null,
		});
		expect(cfg.model).toBe('anthropic/claude-sonnet-5');
		expect(cfg.severityThreshold).toBe('major');
		expect(cfg.reviewTone).toBe('concise');
		// NULL overrides fall back to the installation.
		expect(cfg.provider).toBe('openrouter');
		expect(cfg.ignorePaths).toEqual(['dist/', '*.lock']);
		expect(cfg.inherits).toEqual({
			provider: true,
			model: false,
			severityThreshold: false,
			reviewTone: false,
			ignorePaths: true,
		});
	});

	it('reports a disabled repo as disabled even with overrides present', () => {
		const cfg = mergeRepoConfig(INSTALLATION, {
			enabled: 0,
			provider: null,
			model: null,
			severity_threshold: null,
			review_tone: null,
			ignore_paths: null,
		});
		expect(cfg.enabled).toBe(false);
	});

	it('degrades an unknown stored severity instead of hiding findings', () => {
		const cfg = mergeRepoConfig({ ...INSTALLATION, severity_threshold: 'nonsense' }, null);
		expect(cfg.severityThreshold).toBe('all');
	});
});

describe('loadRepoConfig', () => {
	it('returns null when the installation has never been configured', async () => {
		const { db } = makeFakeDb({ installationConfig: null });
		expect(await loadRepoConfig(db, 1, 'ekojoecovenant', 'alphapr')).toBeNull();
	});

	it('reads the key and the defaults in one query, with repo overrides applied', async () => {
		const { db } = makeFakeDb({
			installationConfig: INSTALLATION,
			repoOverrides: {
				'1:ekojoecovenant/noisy': {
					enabled: 0,
					provider: null,
					model: null,
					severity_threshold: 'major',
					review_tone: null,
					ignore_paths: null,
				},
			},
		});

		const cfg = await loadRepoConfig(db, 1, 'ekojoecovenant', 'noisy');
		expect(cfg?.apiKeyEncrypted).toBe('iv.ciphertext');
		expect(cfg?.accountLogin).toBe('ekojoecovenant');
		expect(cfg?.enabled).toBe(false);
		expect(cfg?.severityThreshold).toBe('major');
		expect(cfg?.model).toBe('deepseek/deepseek-v4-flash');

		// A different repo under the same installation gets the installation default.
		const other = await loadRepoConfig(db, 1, 'ekojoecovenant', 'alphapr');
		expect(other?.enabled).toBe(true);
		expect(other?.severityThreshold).toBe('minor');
	});
});

describe('shouldReviewRepo', () => {
	it('defaults to yes when no repo row exists', async () => {
		const { db } = makeFakeDb();
		expect(await shouldReviewRepo(db, 1, 'ekojoecovenant', 'alphapr')).toBe(true);
	});

	it('says no for a disabled repo', async () => {
		const { db } = makeFakeDb({
			repoOverrides: {
				'1:ekojoecovenant/noisy': {
					enabled: 0,
					provider: null,
					model: null,
					severity_threshold: null,
					review_tone: null,
					ignore_paths: null,
				},
			},
		});
		expect(await shouldReviewRepo(db, 1, 'ekojoecovenant', 'noisy')).toBe(false);
	});

	it('fails open when the database throws, so a hiccup cannot silence reviews', async () => {
		const db = {
			prepare: () => {
				throw new Error('D1_ERROR: network');
			},
		} as unknown as D1Database;
		expect(await shouldReviewRepo(db, 1, 'ekojoecovenant', 'alphapr')).toBe(true);
	});
});

describe('saveRepoOverride', () => {
	it('writes every column, with null meaning inherit', async () => {
		const { db, writes } = seedConfig();
		await saveRepoOverride(db, 1, 'ekojoecovenant', 'noisy', {
			enabled: false,
			severityThreshold: 'major',
			ignorePaths: 'dist/',
		});

		const insert = writes.find((w) => w.sql.includes('INSERT INTO repos'));
		expect(insert).toBeDefined();
		expect(insert?.args).toEqual([1, 'ekojoecovenant', 'noisy', 0, null, null, 'major', null, 'dist/']);
	});

	it('keeps stored values that the patch does not mention', async () => {
		const { db, writes } = makeFakeDb({
			repoOverrides: {
				'1:ekojoecovenant/noisy': {
					enabled: 1,
					provider: 'anthropic',
					model: 'claude-sonnet-5',
					severity_threshold: 'minor',
					review_tone: 'concise',
					ignore_paths: 'vendor/',
				},
			},
		});

		await saveRepoOverride(db, 1, 'ekojoecovenant', 'noisy', { enabled: false });
		const insert = writes.find((w) => w.sql.includes('INSERT INTO repos'));
		expect(insert?.args).toEqual([1, 'ekojoecovenant', 'noisy', 0, 'anthropic', 'claude-sonnet-5', 'minor', 'concise', 'vendor/']);
	});

	it('clears a field when the patch says null', async () => {
		const { db, writes } = makeFakeDb({
			repoOverrides: {
				'1:ekojoecovenant/noisy': {
					enabled: 1,
					provider: 'anthropic',
					model: 'claude-sonnet-5',
					severity_threshold: null,
					review_tone: null,
					ignore_paths: null,
				},
			},
		});

		await saveRepoOverride(db, 1, 'ekojoecovenant', 'noisy', { model: null });
		const insert = writes.find((w) => w.sql.includes('INSERT INTO repos'));
		expect(insert?.args).toEqual([1, 'ekojoecovenant', 'noisy', 1, 'anthropic', null, null, null, null]);
	});
});

describe('clearRepoOverride', () => {
	it('deletes the row so the repo inherits everything again', async () => {
		const { db, writes } = seedConfig();
		await clearRepoOverride(db, 1, 'ekojoecovenant', 'noisy');
		expect(writes).toHaveLength(1);
		expect(writes[0]?.sql).toContain('DELETE FROM repos');
		expect(writes[0]?.args).toEqual([1, 'ekojoecovenant', 'noisy']);
	});
});
