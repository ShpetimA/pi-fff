import assert from "node:assert/strict";
import test from "node:test";
import { Result } from "better-result";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isUrlPath } from "../src/extension-common.ts";
import { MissingPathError } from "../src/errors.ts";
import type { FffRuntime } from "../src/fff.ts";
import { registerTools, type ToolRegistrationDeps } from "../src/register-tools.ts";

test("isUrlPath accepts host URLs and rejects filesystem paths", () => {
	for (const url of [
		"skill://watch-mill-record-progress",
		"skill://name/references/notes.md",
		"memory://root/memory_summary.md",
		"artifact://12",
		"local://scratch.md",
		"https://example.com/page",
		// The host also accepts a filesystem path prefixed onto a URL.
		"/home/me/repo/local://scratch.md",
		// …and its single-slash alias.
		"local:/scratch.md",
	]) {
		assert.equal(isUrlPath(url), true, url);
	}

	for (const path of [
		"src/register-tools.ts",
		"./src/register-tools.ts",
		"/home/me/repo/src/register-tools.ts",
		"src/fff-runtime.ts:398",
		"C:/Users/me/project/src/index.ts",
		"notes/2026-11-10.md",
	]) {
		assert.equal(isUrlPath(path), false, path);
	}
});

/** A runtime that records every query and always reports the miss FFF would report. */
function recordingRuntime(queries: string[]): FffRuntime {
	return {
		resolvePath: async (query: string) => {
			queries.push(query);
			return Result.err(new MissingPathError({ query, reason: `No files matched "${query}".` }));
		},
		trackQuery: async () => {},
	} as unknown as FffRuntime;
}

function registerReadTool(runtime: FffRuntime) {
	const tools: { name: string; execute: (...args: never[]) => unknown }[] = [];
	const pi = { registerTool: (tool: { name: string }) => tools.push(tool as never) } as unknown as ExtensionAPI;
	const deps: ToolRegistrationDeps = {
		getRuntime: () => runtime,
		isFeatureEnabled: () => true,
		agentToolsDisabledText: () => "disabled",
		registerBuiltInReadEnhancement: true,
		registerBuiltInGrepEnhancement: false,
	};
	registerTools(pi, deps);
	const read = tools.find((tool) => tool.name === "read");
	assert.ok(read, "read tool registered");
	return read;
}

test("read hands a skill:// URL to the built-in tool instead of FFF", async () => {
	const queries: string[] = [];
	const read = registerReadTool(recordingRuntime(queries));

	// The built-in tool needs a live session, which a unit test has none of; the point of the test is
	// that FFF never sees the URL, so the built-in tool's own failure is expected and ignored.
	await (read.execute as (...args: unknown[]) => Promise<unknown>)(
		"call-1",
		{ path: "skill://watch-mill-record-progress" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	).catch(() => undefined);

	assert.deepEqual(queries, []);
});

test("read still resolves a plain path through FFF", async () => {
	const queries: string[] = [];
	const read = registerReadTool(recordingRuntime(queries));

	const result = (await (read.execute as (...args: unknown[]) => Promise<{ content: { text: string }[] }>)(
		"call-2",
		{ path: "src/register-tools.ts" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	)) as { content: { text: string }[] };

	assert.deepEqual(queries, ["src/register-tools.ts"]);
	assert.match(result.content[0].text, /No files matched/);
});
