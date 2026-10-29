import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";
import { FffAtAutocompleteProvider } from "../src/editor.ts";
import type { FffRuntime } from "../src/fff.ts";

type SuggestionCall = {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
	options: unknown;
};

function candidate(relativePath: string, matchType = "fuzzy_filename") {
	return {
		item: { path: `/repo/${relativePath}`, relativePath, fileName: relativePath.split("/").pop() ?? relativePath },
		score: { matchType },
	};
}

class FakeBaseProvider implements AutocompleteProvider {
	calls: SuggestionCall[] = [];
	applied: Array<{ lines: string[]; item: string; prefix: string }> = [];
	result: AutocompleteSuggestions | null;

	constructor(result: AutocompleteSuggestions | null = null) {
		this.result = result;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal },
	): Promise<AutocompleteSuggestions | null> {
		this.calls.push({ lines, cursorLine, cursorCol, options });
		return this.result;
	}

	applyCompletion(
		lines: string[],
		_cursorLine: number,
		_cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		this.applied.push({ lines, item: item.value, prefix });
		return { lines, cursorLine: 0, cursorCol: 0 };
	}
}

function makeRuntime(candidates: unknown[] | Error = [candidate("src/app.ts")]) {
	const queries: string[] = [];
	const tracked: Array<{ prefix: string; value: string }> = [];
	const runtime = {
		searchFileCandidates: async (query: string, limit: number) => {
			queries.push(query);
			assert.equal(limit, 20, "provider should ask fff for MAX_RESULTS candidates");
			if (candidates instanceof Error) return { isErr: () => true, isOk: () => false };
			return { isErr: () => false, isOk: () => true, value: candidates };
		},
		trackQuery: async (prefix: string, value: string) => {
			tracked.push({ prefix, value });
		},
	};
	return { runtime: runtime as unknown as FffRuntime, queries, tracked };
}

function lines(...text: string[]): string[] {
	return text;
}

test("accepts the pi host shape: { signal } as the 4th argument", async () => {
	const base = new FakeBaseProvider();
	const { runtime, queries } = makeRuntime();
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const result = await provider.getSuggestions(lines("@src/ap"), 0, 7, { signal: new AbortController().signal });

	assert.deepEqual(queries, ["src/ap"]);
	assert.deepEqual(result, {
		prefix: "@src/ap",
		items: [
			{
				value: "@src/app.ts",
				label: "app.ts",
				description: "src/app.ts · fuzzy_filename",
			},
		],
	});
	assert.equal(base.calls.length, 0, "base provider must not run when fff has matches");
});

test("accepts the omp host shape: a bare AbortSignal", async () => {
	const base = new FakeBaseProvider();
	const { runtime, queries } = makeRuntime();
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const result = await provider.getSuggestions(lines("@src/ap"), 0, 7, new AbortController().signal);

	assert.deepEqual(queries, ["src/ap"], "a bare signal must not throw before the lookup");
	assert.equal(result?.prefix, "@src/ap");
	assert.equal(result?.items[0]?.value, "@src/app.ts");
});

test("tolerates a missing 4th argument", async () => {
	const base = new FakeBaseProvider();
	const { runtime } = makeRuntime();
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const result = await provider.getSuggestions(lines("@src"), 0, 4, undefined);

	assert.equal(result?.prefix, "@src");
});

test("returns null when the bare signal is already aborted", async () => {
	const base = new FakeBaseProvider();
	const { runtime, queries } = makeRuntime();
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const controller = new AbortController();
	controller.abort();

	const result = await provider.getSuggestions(lines("@src"), 0, 4, controller.signal);

	assert.equal(result, null);
	assert.deepEqual(queries, [], "an aborted request must not hit fff");
	assert.equal(base.calls.length, 0);
});

test("returns null when the { signal } shape is already aborted", async () => {
	const base = new FakeBaseProvider();
	const { runtime, queries } = makeRuntime();
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const controller = new AbortController();
	controller.abort();

	const result = await provider.getSuggestions(lines("@src"), 0, 4, { signal: controller.signal });

	assert.equal(result, null);
	assert.deepEqual(queries, []);
});

test("aborting while fff is in flight falls back without throwing", async () => {
	const base = new FakeBaseProvider(null);
	const controller = new AbortController();
	const runtime = {
		searchFileCandidates: async () => {
			controller.abort();
			return { isErr: () => false, value: [candidate("src/app.ts")] };
		},
	} as unknown as FffRuntime;
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const result = await provider.getSuggestions(lines("@src"), 0, 4, controller.signal);

	assert.equal(result, null);
	assert.equal(base.calls.length, 1, "an aborted in-flight lookup yields to the base provider");
});

test("forwards non-@ text to the base provider in the host's own shape", async () => {
	const base = new FakeBaseProvider({ items: [{ value: "x", label: "x" }], prefix: "x" });
	const { runtime, queries } = makeRuntime();
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const bareSignal = new AbortController().signal;
	await provider.getSuggestions(lines("src/ap"), 0, 6, bareSignal);

	assert.deepEqual(queries, [], "plain paths are the base provider's business");
	assert.equal(base.calls.length, 1);
	assert.equal(base.calls[0]?.options, bareSignal, "the signal shape must pass through unchanged");
});

test("falls back to the base provider when fff returns no candidates", async () => {
	const base = new FakeBaseProvider({ items: [{ value: "@src/app.ts", label: "app.ts" }], prefix: "@src" });
	const { runtime } = makeRuntime([]);
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const result = await provider.getSuggestions(lines("@src"), 0, 4, new AbortController().signal);

	assert.equal(base.calls.length, 1);
	assert.equal(result?.items[0]?.label, "app.ts");
});

test("falls back to the base provider when fff errors", async () => {
	const base = new FakeBaseProvider(null);
	const { runtime } = makeRuntime(new Error("finder unavailable"));
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const result = await provider.getSuggestions(lines("@src"), 0, 4, new AbortController().signal);

	assert.equal(base.calls.length, 1, "an fff failure must not break @ completion");
	assert.equal(result, null);
});

test("quotes suggestions for a quoted prefix", async () => {
	const base = new FakeBaseProvider();
	const { runtime } = makeRuntime([candidate("src/my file.ts")]);
	const provider = new FffAtAutocompleteProvider(base, runtime);

	const result = await provider.getSuggestions(lines('@"src/my'), 0, 8, new AbortController().signal);

	assert.equal(result?.prefix, '@"src/my');
	assert.deepEqual(
		result?.items.map((item: AutocompleteItem) => item.value),
		['@"src/my file.ts"'],
	);
});

test("applyCompletion records the query and delegates to the base provider", async () => {
	const base = new FakeBaseProvider();
	const { runtime, tracked } = makeRuntime();
	const provider = new FffAtAutocompleteProvider(base, runtime);

	provider.applyCompletion(["@src"], 0, 4, { value: '@"src/app.ts"', label: "app.ts" }, "@src");

	assert.deepEqual(tracked, [{ prefix: "@src", value: "src/app.ts" }]);
	assert.deepEqual(base.applied, [{ lines: ["@src"], item: '@"src/app.ts"', prefix: "@src" }]);
});

test("shouldTriggerFileCompletion delegates, defaulting to true", () => {
	const { runtime } = makeRuntime();
	const withoutHook = new FffAtAutocompleteProvider(new FakeBaseProvider(), runtime);
	const withHook = new FffAtAutocompleteProvider(
		Object.assign(new FakeBaseProvider(), { shouldTriggerFileCompletion: () => false }),
		runtime,
	);

	assert.equal(withoutHook.shouldTriggerFileCompletion?.([], 0, 0), true);
	assert.equal(withHook.shouldTriggerFileCompletion?.([], 0, 0), false);
});
