import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FileFinder, GrepCursor, Result, SearchResult, GrepResult } from "@ff-labs/fff-node";
import { FffRuntime, type GrepMatch } from "../src/fff.ts";

function ok<T>(value: T): Result<T> {
	return { ok: true, value };
}

function makeMatch(relativePath: string, lineNumber: number, text: string): GrepMatch {
	const matchStart = Math.max(0, text.indexOf("needle"));
	return {
		path: `/repo/${relativePath}`,
		relativePath,
		fileName: relativePath.split("/").pop() ?? relativePath,
		gitStatus: "clean",
		size: 64,
		modified: 0,
		isBinary: false,
		totalFrecencyScore: 0,
		accessFrecencyScore: 0,
		modificationFrecencyScore: 0,
		lineNumber,
		col: matchStart,
		byteOffset: 0,
		lineContent: text,
		matchRanges: matchStart >= 0 ? [[matchStart, matchStart + 6]] : [],
		contextBefore: [],
		contextAfter: [],
	};
}

function createMockFinder(overrides: Partial<FileFinder>): FileFinder {
	return {
		destroy() {},
		fileSearch() {
			throw new Error("fileSearch not implemented");
		},
		grep() {
			throw new Error("grep not implemented");
		},
		multiGrep() {
			throw new Error("multiGrep not implemented");
		},
		scanFiles() {
			return ok(undefined);
		},
		isScanning() {
			return false;
		},
		getScanProgress() {
			return ok({ scannedFilesCount: 0, isScanning: false });
		},
		waitForScan: async () => ok(true),
		reindex() {
			return ok(undefined);
		},
		refreshGitStatus() {
			return ok(0);
		},
		trackQuery() {
			return ok(true);
		},
		getHistoricalQuery() {
			return ok(null);
		},
		healthCheck() {
			return ok({
				version: "test",
				git: { available: true, repositoryFound: false, libgit2Version: "test" },
				filePicker: { initialized: true, indexedFiles: 0 },
				frecency: { initialized: false },
				queryTracker: { initialized: false },
			});
		},
		get isDestroyed() {
			return false;
		},
		...overrides,
	} as unknown as FileFinder;
}

test("findFiles retries 3+ word empty queries with first two words and preserves that across cursor pages", async () => {
	const calls: Array<{ query: string; pageIndex?: number; pageSize?: number }> = [];
	const finder = createMockFinder({
		fileSearch(query, options): Result<SearchResult> {
			calls.push({ query, pageIndex: options?.pageIndex, pageSize: options?.pageSize });
			const pageIndex = options?.pageIndex ?? 0;
			if (query === "alpha beta gamma") {
				return ok({ items: [], scores: [], totalMatched: 0, totalFiles: 10 });
			}
			if (query === "alpha beta") {
				const items = pageIndex === 0
					? [
						{ path: "/repo/src/a.ts", relativePath: "src/a.ts", fileName: "a.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" },
						{ path: "/repo/src/b.ts", relativePath: "src/b.ts", fileName: "b.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" },
					]
					: [
						{ path: "/repo/src/c.ts", relativePath: "src/c.ts", fileName: "c.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" },
					];
				return ok({
					items,
					scores: items.map((_, index) => ({ total: 100 - index, baseScore: 100, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: index === 0 && pageIndex === 0, matchType: index === 0 && pageIndex === 0 ? "exact" : "fuzzy" })),
					totalMatched: 3,
					totalFiles: 10,
				});
			}
			throw new Error(`unexpected query: ${query}`);
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const first = await runtime.findFiles({ query: "alpha beta gamma", limit: 2 });
	assert.equal(first.isOk(), true);
	if (first.isErr()) assert.fail(first.error.message);
	assert.equal(first.value.items.length, 2);
	assert.ok(first.value.nextCursor);
	assert.deepEqual(calls.map((call) => `${call.query}@${call.pageIndex ?? 0}`), ["alpha beta gamma@0", "alpha beta@0"]);

	const second = await runtime.findFiles({ query: "alpha beta gamma", limit: 2, cursor: first.value.nextCursor });
	assert.equal(second.isOk(), true);
	if (second.isErr()) assert.fail(second.error.message);
	assert.equal(second.value.items.length, 1);
	assert.equal(second.value.nextCursor, undefined);
	assert.deepEqual(calls.map((call) => `${call.query}@${call.pageIndex ?? 0}`), ["alpha beta gamma@0", "alpha beta@0", "alpha beta@1"]);
});

test("findFiles returns paginated cursor and continues on next page", async () => {
	const calls: Array<{ query: string; pageIndex?: number; pageSize?: number }> = [];
	const finder = createMockFinder({
		fileSearch(query, options): Result<SearchResult> {
			calls.push({ query, pageIndex: options?.pageIndex, pageSize: options?.pageSize });
			const pageIndex = options?.pageIndex ?? 0;
			const items = pageIndex === 0
				? [
					{ path: "/repo/src/a.ts", relativePath: "src/a.ts", fileName: "a.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" },
					{ path: "/repo/src/b.ts", relativePath: "src/b.ts", fileName: "b.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" },
				]
				: [
					{ path: "/repo/src/c.ts", relativePath: "src/c.ts", fileName: "c.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" },
				];
			return ok({
				items,
				scores: items.map((_, index) => ({ total: 100 - index, baseScore: 100, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: index === 0 && pageIndex === 0, matchType: index === 0 && pageIndex === 0 ? "exact" : "fuzzy" })),
				totalMatched: 3,
				totalFiles: 10,
			});
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const first = await runtime.findFiles({ query: "src", limit: 2 });
	assert.equal(first.isOk(), true);
	if (first.isErr()) assert.fail(first.error.message);
	assert.equal(first.value.items.length, 2);
	assert.ok(first.value.nextCursor);
	assert.match(first.value.formatted, /cursor:/);

	const second = await runtime.findFiles({ query: "src", limit: 2, cursor: first.value.nextCursor });
	assert.equal(second.isOk(), true);
	if (second.isErr()) assert.fail(second.error.message);
	assert.equal(second.value.items.length, 1);
	assert.equal(second.value.nextCursor, undefined);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((call) => call.pageIndex), [0, 1]);
});

test("findFiles handles non-ASCII file names", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fff-unicode-"));
	await mkdir(join(root, "src"), { recursive: true });
	const filePath = join(root, "src", "14 февраля AppStore.ts");
	await writeFile(filePath, "export const appStore = true;\n", "utf8");

	const runtime = new FffRuntime(root, { projectRoot: root });
	try {
		const warm = await runtime.warm(5000);
		assert.equal(warm.isOk(), true);
		if (warm.isErr()) assert.fail(warm.error.message);

		const reindex = await runtime.reindex();
		assert.equal(reindex.isOk(), true);
		if (reindex.isErr()) assert.fail(reindex.error.message);

		const scanned = await runtime.warm(5000);
		assert.equal(scanned.isOk(), true);
		if (scanned.isErr()) assert.fail(scanned.error.message);

		const result = await runtime.findFiles({ query: "AppStore", limit: 5 });
		assert.equal(result.isOk(), true);
		if (result.isErr()) assert.fail(result.error.message);
		assert.equal(result.value.items[0]?.item.relativePath, "src/14 февраля AppStore.ts");
	} finally {
		runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("resolvePath prefers project-root exact paths while still allowing explicit cwd-relative paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fff-root-"));
	const repo = join(root, "repo");
	const nested = join(repo, "packages", "app");
	await mkdir(join(repo, ".git"), { recursive: true });
	await mkdir(join(repo, "src"), { recursive: true });
	await mkdir(join(nested, "src"), { recursive: true });
	await writeFile(join(repo, "src", "root.ts"), "export const root = true;\n", "utf8");
	await writeFile(join(nested, "src", "root.ts"), "export const local = true;\n", "utf8");
	await writeFile(join(nested, "local.ts"), "export const nested = true;\n", "utf8");

	const runtime = new FffRuntime(nested, { finder: createMockFinder({}), projectRoot: repo });

	const rootRelative = await runtime.resolvePath("src/root.ts");
	assert.equal(rootRelative.isOk(), true);
	if (rootRelative.isErr()) assert.fail(rootRelative.error.message);
	assert.equal(rootRelative.value.absolutePath, join(repo, "src", "root.ts"));
	assert.equal(rootRelative.value.relativePath, "src/root.ts");

	const explicitCwd = await runtime.resolvePath("./src/root.ts");
	assert.equal(explicitCwd.isOk(), true);
	if (explicitCwd.isErr()) assert.fail(explicitCwd.error.message);
	assert.equal(explicitCwd.value.absolutePath, join(nested, "src", "root.ts"));
	assert.equal(explicitCwd.value.relativePath, "packages/app/src/root.ts");

	const cwdFallback = await runtime.resolvePath("local.ts");
	assert.equal(cwdFallback.isOk(), true);
	if (cwdFallback.isErr()) assert.fail(cwdFallback.error.message);
	assert.equal(cwdFallback.value.absolutePath, join(nested, "local.ts"));
	assert.equal(cwdFallback.value.relativePath, "packages/app/local.ts");
});

test("resolvePath expands tilde paths before checking direct filesystem matches", async () => {
	const root = await mkdtemp(join(homedir(), "pi-fff-home-"));
	const filePath = join(root, "tilde.ts");
	await writeFile(filePath, "export const tilde = true;\n", "utf8");

	try {
		const runtime = new FffRuntime(process.cwd(), { finder: createMockFinder({}) });
		const resolved = await runtime.resolvePath(`~/${filePath.slice(homedir().length + 1)}`);
		assert.equal(resolved.isOk(), true);
		if (resolved.isErr()) assert.fail(resolved.error.message);
		assert.equal(resolved.value.absolutePath, filePath);
		assert.equal(resolved.value.pathType, "file");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolvePath uses MCP-style best-match heuristic", async () => {
	const finder = createMockFinder({
		fileSearch(query): Result<SearchResult> {
			const items = [
				{ path: "/repo/src/a.ts", relativePath: "src/a.ts", fileName: "a.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" },
				{ path: "/repo/src/b.ts", relativePath: "src/b.ts", fileName: "b.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" },
			];
			const scores = query === "clear"
				? [
					{ total: 100, baseScore: 100, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: false, matchType: "fuzzy" },
					{ total: 40, baseScore: 40, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: false, matchType: "fuzzy" },
				]
				: [
					{ total: 100, baseScore: 100, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: false, matchType: "fuzzy" },
					{ total: 60, baseScore: 60, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: false, matchType: "fuzzy" },
				];
			return ok({ items, scores, totalMatched: items.length, totalFiles: items.length });
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const clear = await runtime.resolvePath("clear");
	assert.equal(clear.isOk(), true);
	if (clear.isErr()) assert.fail(clear.error.message);
	assert.equal(clear.value.relativePath, "src/a.ts");

	const close = await runtime.resolvePath("close");
	assert.equal(close.isErr(), true);
	if (close.isOk()) assert.fail("expected ambiguous result");
	assert.equal(close.error._tag, "AmbiguousPathError");
	assert.equal(close.error.candidates.length, 2);
});

test("grepSearch reuses stored cursor items before touching finder again", async () => {
	let multiGrepCalls = 0;
	const finder = createMockFinder({
		multiGrep(): Result<GrepResult> {
			multiGrepCalls += 1;
			return ok({
				items: [
					makeMatch("src/a.ts", 1, "needle one"),
					makeMatch("src/b.ts", 2, "needle two"),
					makeMatch("src/c.ts", 3, "needle three"),
				],
				totalMatched: 3,
				totalFilesSearched: 1,
				totalFiles: 3,
				filteredFileCount: 3,
				nextCursor: null,
			});
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const first = await runtime.grepSearch({ pattern: "needle", limit: 2, includeCursorHint: true });
	assert.equal(first.isOk(), true);
	if (first.isErr()) assert.fail(first.error.message);
	assert.equal(first.value.items.length, 2);
	assert.ok(first.value.nextCursor);
	assert.equal(multiGrepCalls, 1);

	const second = await runtime.grepSearch({ pattern: "needle", limit: 2, cursor: first.value.nextCursor, includeCursorHint: true });
	assert.equal(second.isOk(), true);
	if (second.isErr()) assert.fail(second.error.message);
	assert.equal(second.value.items.length, 1);
	assert.equal(second.value.items[0]?.relativePath, "src/c.ts");
	assert.equal(multiGrepCalls, 1);
});

test("grepSearch auto-broadens empty multi-word queries", async () => {
	const calls: string[][] = [];
	const finder = createMockFinder({
		multiGrep(options): Result<GrepResult> {
			calls.push(options.patterns);
			if (options.patterns[0] === "alpha beta") {
				return ok({
					items: [],
					totalMatched: 0,
					totalFilesSearched: 1,
					totalFiles: 2,
					filteredFileCount: 2,
					nextCursor: null,
				});
			}
			if (options.patterns[0] === "beta") {
				return ok({
					items: [makeMatch("src/example.ts", 4, "const beta = true;")],
					totalMatched: 1,
					totalFilesSearched: 1,
					totalFiles: 2,
					filteredFileCount: 2,
					nextCursor: null,
				});
			}
			throw new Error(`unexpected query: ${options.patterns[0]}`);
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const result = await runtime.grepSearch({ pattern: "alpha beta", limit: 5 });
	assert.equal(result.isOk(), true);
	if (result.isErr()) assert.fail(result.error.message);
	assert.deepEqual(calls, [["alpha beta"], ["beta"]]);
	assert.match(result.value.formatted, /Auto-broadened to "beta"/);
	assert.match(result.value.formatted, /src\/example.ts:4: const beta = true;/);
});

test("grepSearch falls back to fuzzy search when exact search finds nothing", async () => {
	const grepCalls: Array<{ query: string; mode: string | undefined }> = [];
	const multiCalls: string[][] = [];
	const finder = createMockFinder({
		multiGrep(options): Result<GrepResult> {
			multiCalls.push(options.patterns);
			return ok({
				items: [],
				totalMatched: 0,
				totalFilesSearched: 1,
				totalFiles: 2,
				filteredFileCount: 2,
				nextCursor: null,
			});
		},
		grep(query, options): Result<GrepResult> {
			grepCalls.push({ query, mode: options?.mode });
			if (options?.mode === "fuzzy") {
				return ok({
					items: [makeMatch("src/example.ts", 8, "const needle = true;")],
					totalMatched: 1,
					totalFilesSearched: 1,
					totalFiles: 2,
					filteredFileCount: 2,
					nextCursor: null,
				});
			}
			return ok({
				items: [],
				totalMatched: 0,
				totalFilesSearched: 1,
				totalFiles: 2,
				filteredFileCount: 2,
				nextCursor: null,
			});
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const result = await runtime.grepSearch({ pattern: "neddle", limit: 5 });
	assert.equal(result.isOk(), true);
	if (result.isErr()) assert.fail(result.error.message);
	assert.deepEqual(multiCalls, [["neddle"]]);
	assert.deepEqual(grepCalls, [{ query: "neddle", mode: "fuzzy" }]);
	assert.match(result.value.formatted, /0 exact matches\. 1 approximate:/);
	assert.match(result.value.formatted, /src\/example.ts/);
});

test("grepSearch suggests a relevant file path when content search is empty", async () => {
	const finder = createMockFinder({
		grep(): Result<GrepResult> {
			return ok({
				items: [],
				totalMatched: 0,
				totalFilesSearched: 1,
				totalFiles: 2,
				filteredFileCount: 2,
				nextCursor: null,
			});
		},
		multiGrep(): Result<GrepResult> {
			return ok({
				items: [],
				totalMatched: 0,
				totalFilesSearched: 1,
				totalFiles: 2,
				filteredFileCount: 2,
				nextCursor: null,
			});
		},
		fileSearch(query): Result<SearchResult> {
			assert.equal(query, "src/components/button.ts");
			const items = [
				{ path: "/repo/src/components/button.ts", relativePath: "src/components/button.ts", fileName: "button.ts", size: 1, modified: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 200, gitStatus: "modified" },
			];
			return ok({
				items,
				scores: [{ total: 500, baseScore: 500, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 20, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: true, matchType: "exact" }],
				totalMatched: 1,
				totalFiles: 10,
			});
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const result = await runtime.grepSearch({ pattern: "src/components/button.ts", limit: 5 });
	assert.equal(result.isOk(), true);
	if (result.isErr()) assert.fail(result.error.message);
	assert.match(result.value.formatted, /0 content matches\. But there is a relevant file path: src\/components\/button.ts/);
});

test("multiGrepSearch falls back to single-pattern searches when multi-grep is empty", async () => {
	const multiCalls: string[][] = [];
	const finder = createMockFinder({
		multiGrep(options): Result<GrepResult> {
			multiCalls.push(options.patterns);
			if (options.patterns.length === 2) {
				return ok({
					items: [],
					totalMatched: 0,
					totalFilesSearched: 1,
					totalFiles: 3,
					filteredFileCount: 3,
					nextCursor: null,
				});
			}
			if (options.patterns[0] === "FirstVariant") {
				return ok({
					items: [],
					totalMatched: 0,
					totalFilesSearched: 1,
					totalFiles: 3,
					filteredFileCount: 3,
					nextCursor: null,
				});
			}
			if (options.patterns[0] === "second_variant") {
				return ok({
					items: [makeMatch("src/example.ts", 7, "const second_variant = true;")],
					totalMatched: 1,
					totalFilesSearched: 1,
					totalFiles: 3,
					filteredFileCount: 3,
					nextCursor: null,
				});
			}
			throw new Error(`unexpected patterns: ${options.patterns.join(",")}`);
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const result = await runtime.multiGrepSearch({ patterns: ["FirstVariant", "second_variant"], limit: 5 });
	assert.equal(result.isOk(), true);
	if (result.isErr()) assert.fail(result.error.message);
	assert.deepEqual(multiCalls, [["FirstVariant", "second_variant"], ["FirstVariant"], ["second_variant"]]);
	assert.match(result.value.formatted, /0 multi-pattern matches\. Plain grep fallback for "second_variant":/);
	assert.match(result.value.formatted, /src\/example.ts:7: const second_variant = true;/);
});

test("grepSearch uses multi-grep engine for slash/brace literal patterns", async () => {
	let multiCalls = 0;
	const pattern = "/repos/{owner}/{repo}/pulls/{pull_number}/files";
	const finder = createMockFinder({
		grep(): Result<GrepResult> {
			throw new Error("plain search should use multiGrep");
		},
		multiGrep(options): Result<GrepResult> {
			multiCalls += 1;
			assert.deepEqual(options.patterns, [pattern]);
			return ok({
				items: [makeMatch("spec.yaml", 3, `  ${pattern}:`)],
				totalMatched: 1,
				totalFilesSearched: 1,
				totalFiles: 1,
				filteredFileCount: 1,
				nextCursor: null,
			});
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const result = await runtime.grepSearch({ pattern, mode: "plain", limit: 5 });
	assert.equal(result.isOk(), true);
	if (result.isErr()) assert.fail(result.error.message);
	assert.equal(multiCalls, 1);
	assert.equal(result.value.items.length, 1);
	assert.equal(result.value.items[0]?.relativePath, "spec.yaml");
});

test("grepSearch splits pipe-separated literal alternates into multi-grep patterns", async () => {
	const calls: string[][] = [];
	const finder = createMockFinder({
		multiGrep(options): Result<GrepResult> {
			calls.push(options.patterns);
			assert.deepEqual(options.patterns, ["export function DiffWorkspace", "const DiffWorkspace"]);
			return ok({
				items: [makeMatch("src/DiffWorkspace.tsx", 10, "export function DiffWorkspace() {")],
				totalMatched: 1,
				totalFilesSearched: 1,
				totalFiles: 1,
				filteredFileCount: 1,
				nextCursor: null,
			});
		},
	});

	const runtime = new FffRuntime(process.cwd(), { finder });
	const result = await runtime.grepSearch({ pattern: "export function DiffWorkspace|const DiffWorkspace", limit: 5 });
	assert.equal(result.isOk(), true);
	if (result.isErr()) assert.fail(result.error.message);
	assert.deepEqual(calls, [["export function DiffWorkspace", "const DiffWorkspace"]]);
	assert.equal(result.value.items[0]?.relativePath, "src/DiffWorkspace.tsx");
});

test("grepSearch pushes scope and brace globs into native constraints for plain searches", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fff-"));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "example.ts"), "export const needle = true;\n", "utf8");

	const calls: Array<{ patterns: string[]; constraints: string | undefined; cursor: GrepCursor | null | undefined }> = [];
	const finder = createMockFinder({
		grep(): Result<GrepResult> {
			throw new Error("plain search should use multiGrep");
		},
		multiGrep(options): Result<GrepResult> {
			calls.push({ patterns: options.patterns, constraints: options.constraints, cursor: options.cursor });
			return ok({
				items: [makeMatch("src/example.ts", 1, "export const needle = true;")],
				totalMatched: 1,
				totalFilesSearched: 1,
				totalFiles: 1,
				filteredFileCount: 1,
				nextCursor: null,
			});
		},
	});

	const runtime = new FffRuntime(root, { finder });
	const result = await runtime.grepSearch({ pattern: "needle", pathQuery: "src", glob: "*.{ts,tsx}", limit: 5 });
	assert.equal(result.isOk(), true);
	if (result.isErr()) assert.fail(result.error.message);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.patterns, ["needle"]);
	assert.equal(calls[0]?.constraints, "/src/ *.{ts,tsx}");
	assert.equal(result.value.constraintQuery, "/src/ *.{ts,tsx}");
	assert.equal(result.value.scope?.relativePath, "src");
	assert.equal(result.value.items.length, 1);
	assert.equal(result.value.items[0]?.relativePath, "src/example.ts");
});


test("grepSearch treats dot scope as project root", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fff-"));
	await mkdir(join(root, "b"), { recursive: true });
	await writeFile(join(root, "b", "c"), "abc\n", "utf8");

	const finder = createMockFinder({
		multiGrep(): Result<GrepResult> {
			return ok({
				items: [makeMatch("b/c", 1, "abc")],
				totalMatched: 1,
				totalFilesSearched: 1,
				totalFiles: 1,
				filteredFileCount: 1,
				nextCursor: null,
			});
		},
	});

	const runtime = new FffRuntime(root, { finder });
	const result = await runtime.grepSearch({ pattern: "abc", pathQuery: ".", limit: 5 });
	assert.equal(result.isOk(), true);
	if (result.isErr()) assert.fail(result.error.message);
	assert.equal(result.value.scope?.relativePath, ".");
	assert.equal(result.value.items.length, 1);
	assert.equal(result.value.items[0]?.relativePath, "b/c");
});
