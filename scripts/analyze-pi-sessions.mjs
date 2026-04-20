#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPLICIT_FFF_TOOLS = new Set(["find_files", "fff_multi_grep", "fff_grep", "resolve_file", "related_files"]);
const SEARCH_TOOLS = new Set(["grep", "find_files", "fff_multi_grep", "fff_grep", "resolve_file", "related_files"]);
const READ_TOOLS = new Set(["read"]);
const DEFAULT_SESSIONS_DIR = "~/.pi/agent/sessions";

function expandHome(value) {
	if (!value) return value;
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function parseArgs(argv) {
	const args = {
		sessionsDir: DEFAULT_SESSIONS_DIR,
		cwd: undefined,
		before: undefined,
		after: undefined,
		baselineBefore: undefined,
		fffAfter: undefined,
		followWindow: 3,
		top: 10,
		maxSessions: undefined,
		json: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--sessions-dir") {
			args.sessionsDir = next;
			i += 1;
		} else if (arg === "--cwd") {
			args.cwd = next;
			i += 1;
		} else if (arg === "--before") {
			args.before = next;
			i += 1;
		} else if (arg === "--after") {
			args.after = next;
			i += 1;
		} else if (arg === "--baseline-before") {
			args.baselineBefore = next;
			i += 1;
		} else if (arg === "--fff-after") {
			args.fffAfter = next;
			i += 1;
		} else if (arg === "--follow-window") {
			args.followWindow = Number(next);
			i += 1;
		} else if (arg === "--top") {
			args.top = Number(next);
			i += 1;
		} else if (arg === "--max-sessions") {
			args.maxSessions = Number(next);
			i += 1;
		} else if (arg === "--json") {
			args.json = true;
		} else if (arg === "--help" || arg === "-h") {
			args.help = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	args.sessionsDir = expandHome(args.sessionsDir);
	if (args.cwd) args.cwd = expandHome(args.cwd);
	return args;
}

function printHelp() {
	console.log(`Analyze pi session logs to see where pi-fff helped, where it failed, and where bash fallback still happens.

Usage:
  node scripts/analyze-pi-sessions.mjs [options]

Options:
  --sessions-dir <dir>      Session root. Default: ${DEFAULT_SESSIONS_DIR}
  --cwd <substring>         Only include sessions whose cwd contains this text
  --after <date>            Only include sessions on/after this ISO-ish date
  --before <date>           Only include sessions on/before this ISO-ish date
  --baseline-before <date>  Extra comparison cohort: sessions before this date
  --fff-after <date>        Extra comparison cohort: sessions on/after this date
  --follow-window <n>       How many later tool calls count as follow-up. Default: 3
  --top <n>                 How many examples to print per section. Default: 10
  --max-sessions <n>        Stop after N matching sessions
  --json                    Output JSON instead of text
  --help, -h                Show this help

Examples:
  node scripts/analyze-pi-sessions.mjs --cwd "$(pwd)"
  node scripts/analyze-pi-sessions.mjs --cwd /Users/timi/proj/pi-fff --json
  node scripts/analyze-pi-sessions.mjs --baseline-before 2026-04-12 --fff-after 2026-04-12
`);
}

function parseDate(value, edge = "start") {
	if (!value) return undefined;
	const raw = value.trim();
	const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
		? `${raw}${edge === "end" ? "T23:59:59.999Z" : "T00:00:00.000Z"}`
		: raw;
	const timestamp = Date.parse(normalized);
	if (Number.isNaN(timestamp)) throw new Error(`Invalid date: ${value}`);
	return timestamp;
}

async function listJsonlFiles(rootDir) {
	const files = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop();
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(fullPath);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
		}
	}
	files.sort();
	return files;
}

function toArray(value) {
	return Array.isArray(value) ? value : [];
}

function toTimestampMs(value) {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function collapseWhitespace(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function textFromContentBlocks(content) {
	return toArray(content)
		.map((block) => (block && typeof block === "object" && block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

function stableStringify(value) {
	if (value === null || value === undefined) return String(value);
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function summarizeCall(name, args) {
	if (!args || typeof args !== "object") return "";
	if (name === "find_files") return collapseWhitespace(args.query ?? "");
	if (name === "grep" || name === "fff_grep") {
		const pattern = collapseWhitespace(args.pattern ?? "");
		const scope = collapseWhitespace(args.path ?? args.constraints ?? "");
		return scope ? `${pattern} @ ${scope}` : pattern;
	}
	if (name === "fff_multi_grep") return toArray(args.patterns).map((item) => collapseWhitespace(item)).join(" | ");
	if (name === "resolve_file") return collapseWhitespace(args.path ?? args.query ?? "");
	if (name === "related_files") return collapseWhitespace(args.path ?? args.query ?? "");
	if (name === "read") return collapseWhitespace(args.path ?? "");
	if (name === "bash") return collapseWhitespace(args.command ?? "");
	return collapseWhitespace(stableStringify(args));
}

function normalizeExample(value, max = 96) {
	const collapsed = collapseWhitespace(value);
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function classifyBashCommand(command) {
	const cmd = collapseWhitespace(command);
	if (!cmd) return { kind: "other", family: "other", summary: "" };
	const patterns = [
		{ regex: /(^|\s)(rg|ripgrep|grep|git\s+grep)\b/i, family: "grep", kind: "search" },
		{ regex: /(^|\s)(fd|find|ls|tree)\b/i, family: "find", kind: "search" },
		{ regex: /(^|\s)(cat|head|tail|sed|awk|jq|bat)\b/i, family: "inspect", kind: "inspect" },
		{ regex: /(^|\s)(python3?|node|ruby|perl)\b/i, family: "script", kind: "script" },
	];
	for (const pattern of patterns) {
		if (pattern.regex.test(cmd)) {
			return { kind: pattern.kind, family: pattern.family, summary: normalizeExample(cmd) };
		}
	}
	return { kind: "other", family: cmd.split(/\s+/)[0] ?? "other", summary: normalizeExample(cmd) };
}

function isSearchLikeCall(call) {
	if (!call) return false;
	if (SEARCH_TOOLS.has(call.name)) return true;
	if (call.name !== "bash") return false;
	return call.bash?.kind === "search" || call.bash?.kind === "inspect";
}

function detectNoResult(call) {
	if (!call?.result) return false;
	const text = call.result.text;
	const details = call.result.details ?? {};
	if (call.name === "find_files") {
		if (typeof details.totalMatched === "number") return details.totalMatched === 0;
		return /^0 results\b/i.test(text);
	}
	if (call.name === "grep" || call.name === "fff_grep" || call.name === "fff_multi_grep") {
		if (/^No matches found\.?$/im.test(text)) return true;
		if (typeof details.matchCount === "number") return details.matchCount === 0;
		if (details.outputMode === "count" && /\b0 matches\b/i.test(text)) return true;
		return false;
	}
	if (call.name === "resolve_file") {
		return /no files matched|could not resolve|not found/i.test(text);
	}
	if (call.name === "related_files") {
		return /^No related files found\.?$/im.test(text);
	}
	return false;
}

function detectReadFailure(call) {
	if (!call?.result) return false;
	if (call.result.isError) return true;
	const text = call.result.text;
	const details = call.result.details ?? {};
	if (details && typeof details === "object" && details.error) return true;
	return /^(Could not resolve|No files matched|FFF runtime is not ready\.|ENOENT:|Error reading|Failed to read)/im.test(text);
}

function createCounter() {
	return new Map();
}

function bump(counter, key, amount = 1) {
	if (!key) return;
	counter.set(key, (counter.get(key) ?? 0) + amount);
}

function topEntries(counter, limit) {
	return Array.from(counter.entries())
		.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
		.slice(0, limit)
		.map(([key, count]) => ({ key, count }));
}

function quantile(numbers, q) {
	if (!numbers.length) return null;
	const sorted = [...numbers].sort((a, b) => a - b);
	const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
	return sorted[index];
}

function percentage(part, total) {
	if (!total) return 0;
	return (part / total) * 100;
}

function rate(part, total) {
	if (!total) return null;
	return part / total;
}

async function parseSessionFile(filePath) {
	const raw = await fs.readFile(filePath, "utf8");
	const lines = raw.split(/\r?\n/).filter(Boolean);
	const callsById = new Map();
	const callOrder = [];
	let sequence = 0;
	let session = {
		path: filePath,
		id: path.basename(filePath, ".jsonl"),
		cwd: null,
		timestamp: null,
		userPrompt: null,
		calls: [],
		orphanResults: 0,
	};

	for (const line of lines) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (event.type === "session") {
			session = {
				...session,
				id: event.id ?? session.id,
				cwd: event.cwd ?? session.cwd,
				timestamp: event.timestamp ?? session.timestamp,
			};
			continue;
		}

		if (event.type !== "message" || !event.message || typeof event.message !== "object") continue;
		const role = event.message.role;
		if (role === "user" && !session.userPrompt) {
			session.userPrompt = normalizeExample(textFromContentBlocks(event.message.content), 180);
			continue;
		}

		if (role === "assistant") {
			const content = toArray(event.message.content);
			for (const block of content) {
				if (!block || typeof block !== "object" || block.type !== "toolCall") continue;
				const call = {
					sessionId: session.id,
					sessionPath: filePath,
					sessionTimestamp: session.timestamp,
					cwd: session.cwd,
					userPrompt: session.userPrompt,
					id: String(block.id ?? `${filePath}:${sequence}`),
					name: String(block.name ?? "unknown"),
					args: block.arguments ?? {},
					summary: summarizeCall(String(block.name ?? "unknown"), block.arguments ?? {}),
					timestamp: event.timestamp,
					timestampMs: toTimestampMs(event.timestamp) ?? toTimestampMs(event.message.timestamp),
					order: sequence,
					result: null,
				};
				call.bash = call.name === "bash" ? classifyBashCommand(call.args.command) : null;
				callOrder.push(call);
				callsById.set(call.id, call);
				sequence += 1;
			}
			continue;
		}

		if (role === "toolResult") {
			const toolCallId = String(event.message.toolCallId ?? "");
			const call = callsById.get(toolCallId);
			const result = {
				toolName: String(event.message.toolName ?? call?.name ?? "unknown"),
				text: textFromContentBlocks(event.message.content),
				details: event.message.details ?? {},
				isError: Boolean(event.message.isError),
				timestamp: event.timestamp,
				timestampMs: toTimestampMs(event.timestamp) ?? toTimestampMs(event.message.timestamp),
			};
			if (call) {
				call.result = result;
			} else {
				session.orphanResults += 1;
			}
		}
	}

	session.calls = callOrder.map((call, index) => ({ ...call, index }));
	session.explicitFff = session.calls.some((call) => EXPLICIT_FFF_TOOLS.has(call.name));
	session.toolCounts = session.calls.reduce((acc, call) => {
		acc[call.name] = (acc[call.name] ?? 0) + 1;
		return acc;
	}, {});
	return session;
}

function includeSession(session, filters) {
	const sessionTime = toTimestampMs(session.timestamp);
	if (filters.cwd && !(session.cwd ?? "").includes(filters.cwd)) return false;
	if (filters.after !== undefined && sessionTime !== undefined && sessionTime < filters.after) return false;
	if (filters.before !== undefined && sessionTime !== undefined && sessionTime > filters.before) return false;
	return true;
}

function buildStats(label, sessions, options) {
	const metrics = {
		label,
		sessions: sessions.length,
		toolCalls: 0,
		searchCalls: 0,
		actionableSearchCalls: 0,
		searchCallsLeadingToRead: 0,
		searchCallsLeadingToBashFallback: 0,
		searchCallsLeadingToRetry: 0,
		noResultSearchCalls: 0,
		searchErrors: 0,
		explicitFffCalls: 0,
		bashCalls: 0,
		bashExplorationCalls: 0,
		bashSearchCalls: 0,
		readCalls: 0,
		readFailures: 0,
		toolCounts: createCounter(),
		toolDurations: new Map(),
		noResultByTool: createCounter(),
		errorByTool: createCounter(),
		bashFamilies: createCounter(),
		bashCommands: createCounter(),
		noResultQueries: createCounter(),
		fallbackExamples: createCounter(),
		retryExamples: createCounter(),
		readFailureExamples: createCounter(),
		actionableSearchExamples: createCounter(),
		orphanResults: sessions.reduce((sum, session) => sum + (session.orphanResults ?? 0), 0),
	};

	for (const session of sessions) {
		for (let index = 0; index < session.calls.length; index += 1) {
			const call = session.calls[index];
			metrics.toolCalls += 1;
			bump(metrics.toolCounts, call.name);
			if (EXPLICIT_FFF_TOOLS.has(call.name)) metrics.explicitFffCalls += 1;
			if (call.name === "bash") {
				metrics.bashCalls += 1;
				if (call.bash?.kind === "search" || call.bash?.kind === "inspect") metrics.bashExplorationCalls += 1;
				if (call.bash?.kind === "search") metrics.bashSearchCalls += 1;
				bump(metrics.bashFamilies, call.bash?.family);
				if (call.bash?.kind === "search" || call.bash?.kind === "inspect") {
					bump(metrics.bashCommands, call.bash.summary);
				}
			}
			if (READ_TOOLS.has(call.name)) {
				metrics.readCalls += 1;
				if (detectReadFailure(call)) {
					metrics.readFailures += 1;
					bump(metrics.readFailureExamples, `${call.name}: ${normalizeExample(call.summary)}`);
				}
			}

			const duration = call.timestampMs !== undefined && call.result?.timestampMs !== undefined
				? Math.max(0, call.result.timestampMs - call.timestampMs)
				: null;
			if (duration !== null) {
				const list = metrics.toolDurations.get(call.name) ?? [];
				list.push(duration);
				metrics.toolDurations.set(call.name, list);
			}

			if (!SEARCH_TOOLS.has(call.name)) continue;
			metrics.searchCalls += 1;
			const isError = Boolean(call.result?.isError || call.result?.details?.error);
			const noResult = detectNoResult(call);
			if (isError) {
				metrics.searchErrors += 1;
				bump(metrics.errorByTool, call.name);
			}
			if (noResult) {
				metrics.noResultSearchCalls += 1;
				bump(metrics.noResultByTool, call.name);
				bump(metrics.noResultQueries, `${call.name}: ${normalizeExample(call.summary)}`);
			}

			const nextCalls = session.calls.slice(index + 1, index + 1 + options.followWindow);
			const followedByRead = nextCalls.some((nextCall) => READ_TOOLS.has(nextCall.name));
			const followedByBashFallback = nextCalls.some((nextCall) => nextCall.name === "bash" && (nextCall.bash?.kind === "search" || nextCall.bash?.kind === "inspect"));
			const followedByRetry = nextCalls.some((nextCall) => isSearchLikeCall(nextCall));

			if (!isError && !noResult) {
				metrics.actionableSearchCalls += 1;
				bump(metrics.actionableSearchExamples, `${call.name}: ${normalizeExample(call.summary)}`);
				if (followedByRead) metrics.searchCallsLeadingToRead += 1;
			} else {
				if (followedByBashFallback) {
					metrics.searchCallsLeadingToBashFallback += 1;
					bump(metrics.fallbackExamples, `${call.name}: ${normalizeExample(call.summary)}`);
				}
				if (followedByRetry) {
					metrics.searchCallsLeadingToRetry += 1;
					bump(metrics.retryExamples, `${call.name}: ${normalizeExample(call.summary)}`);
				}
			}
		}
	}

	const durationsByTool = {};
	for (const [tool, durations] of metrics.toolDurations.entries()) {
		durationsByTool[tool] = {
			count: durations.length,
			p50Ms: quantile(durations, 0.5),
			p95Ms: quantile(durations, 0.95),
			avgMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
		};
	}

	return {
		label,
		sessionCount: metrics.sessions,
		toolCallCount: metrics.toolCalls,
		searchCallCount: metrics.searchCalls,
		actionableSearchCallCount: metrics.actionableSearchCalls,
		searchCallsLeadingToRead: metrics.searchCallsLeadingToRead,
		searchCallsLeadingToBashFallback: metrics.searchCallsLeadingToBashFallback,
		searchCallsLeadingToRetry: metrics.searchCallsLeadingToRetry,
		noResultSearchCallCount: metrics.noResultSearchCalls,
		searchErrorCount: metrics.searchErrors,
		explicitFffCallCount: metrics.explicitFffCalls,
		bashCallCount: metrics.bashCalls,
		bashExplorationCallCount: metrics.bashExplorationCalls,
		bashSearchCallCount: metrics.bashSearchCalls,
		readCallCount: metrics.readCalls,
		readFailureCount: metrics.readFailures,
		orphanResults: metrics.orphanResults,
		rates: {
			actionableSearchToRead: rate(metrics.searchCallsLeadingToRead, metrics.actionableSearchCalls),
			searchNoResult: rate(metrics.noResultSearchCalls, metrics.searchCalls),
			searchError: rate(metrics.searchErrors, metrics.searchCalls),
			searchToBashFallbackAfterFailure: rate(metrics.searchCallsLeadingToBashFallback, metrics.noResultSearchCalls + metrics.searchErrors),
			searchToRetryAfterFailure: rate(metrics.searchCallsLeadingToRetry, metrics.noResultSearchCalls + metrics.searchErrors),
			bashExplorationShare: rate(metrics.bashExplorationCalls, metrics.toolCalls),
			bashSearchShare: rate(metrics.bashSearchCalls, metrics.toolCalls),
			readFailure: rate(metrics.readFailures, metrics.readCalls),
			explicitFffShare: rate(metrics.explicitFffCalls, metrics.toolCalls),
		},
		toolCounts: Object.fromEntries(metrics.toolCounts),
		toolDurations: durationsByTool,
		topNoResultQueries: topEntries(metrics.noResultQueries, options.top),
		topFallbackExamples: topEntries(metrics.fallbackExamples, options.top),
		topRetryExamples: topEntries(metrics.retryExamples, options.top),
		topReadFailures: topEntries(metrics.readFailureExamples, options.top),
		topActionableSearches: topEntries(metrics.actionableSearchExamples, options.top),
		topBashFamilies: topEntries(metrics.bashFamilies, options.top),
		topBashCommands: topEntries(metrics.bashCommands, options.top),
		noResultByTool: Object.fromEntries(metrics.noResultByTool),
		errorByTool: Object.fromEntries(metrics.errorByTool),
	};
}

function compareStats(label, left, right) {
	if (!left || !right || !left.sessionCount || !right.sessionCount) return null;
	const fields = {
		bashExplorationShare: "less bash exploration is better",
		bashSearchShare: "less bash search is better",
		actionableSearchToRead: "higher search→read is better",
		searchNoResult: "lower no-result rate is better",
		searchToBashFallbackAfterFailure: "lower bash fallback after failure is better",
		searchToRetryAfterFailure: "lower retry after failure is better",
		readFailure: "lower read failure rate is better",
		explicitFffShare: "higher explicit pi-fff usage means more adoption",
	};
	const deltas = {};
	for (const key of Object.keys(fields)) {
		const leftValue = left.rates[key];
		const rightValue = right.rates[key];
		deltas[key] = {
			left: leftValue,
			right: rightValue,
			delta: leftValue === null || rightValue === null ? null : rightValue - leftValue,
			note: fields[key],
		};
	}
	return { label, left: left.label, right: right.label, deltas };
}

function formatPct(value) {
	if (value === null || value === undefined) return "n/a";
	return `${(value * 100).toFixed(1)}%`;
}

function formatDelta(value) {
	if (value === null || value === undefined) return "n/a";
	const pct = (value * 100).toFixed(1);
	return `${value > 0 ? "+" : ""}${pct}pp`;
}

function formatCountPart(count, total) {
	if (!total) return `${count}`;
	return `${count} (${percentage(count, total).toFixed(1)}%)`;
}

function renderTopList(title, items) {
	const lines = [title];
	if (!items.length) return [...lines, "  - none"].join("\n");
	for (const item of items) lines.push(`  - ${item.key} — ${item.count}`);
	return lines.join("\n");
}

function renderToolCounts(stats, top) {
	const entries = Object.entries(stats.toolCounts)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, top);
	const lines = ["Top tools"];
	if (!entries.length) return `${lines[0]}\n  - none`;
	for (const [tool, count] of entries) lines.push(`  - ${tool}: ${count}`);
	return lines.join("\n");
}

function renderDurations(stats, top) {
	const entries = Object.entries(stats.toolDurations)
		.sort((a, b) => (a[1].p50Ms ?? Number.POSITIVE_INFINITY) - (b[1].p50Ms ?? Number.POSITIVE_INFINITY))
		.slice(0, top);
	const lines = ["Latency snapshot (p50 / p95)"];
	if (!entries.length) return `${lines[0]}\n  - none`;
	for (const [tool, data] of entries) {
		lines.push(`  - ${tool}: ${data.p50Ms ?? "n/a"}ms / ${data.p95Ms ?? "n/a"}ms (${data.count} samples)`);
	}
	return lines.join("\n");
}

function buildInsights(overall, cohortComparison, timeComparison) {
	const insights = {
		wins: [],
		failures: [],
		improvements: [],
	};

	if ((overall.rates.actionableSearchToRead ?? 0) >= 0.45) {
		insights.wins.push(`Actionable search calls convert into a read ${formatPct(overall.rates.actionableSearchToRead)} of the time.`);
	}
	if ((overall.rates.bashExplorationShare ?? 1) <= 0.12) {
		insights.wins.push(`Bash exploration is relatively contained at ${formatPct(overall.rates.bashExplorationShare)} of all tool calls.`);
	}
	if ((overall.rates.explicitFffShare ?? 0) >= 0.1) {
		insights.wins.push(`Explicit pi-fff tools account for ${formatPct(overall.rates.explicitFffShare)} of all tool calls, so the feature is getting real usage.`);
	}

	if ((overall.rates.searchNoResult ?? 0) >= 0.2) {
		insights.failures.push(`Search no-result rate is ${formatPct(overall.rates.searchNoResult)}.`);
	}
	if ((overall.rates.searchToBashFallbackAfterFailure ?? 0) >= 0.25) {
		insights.failures.push(`After a failed search, bash fallback happens ${formatPct(overall.rates.searchToBashFallbackAfterFailure)} of the time.`);
	}
	if ((overall.rates.readFailure ?? 0) >= 0.05) {
		insights.failures.push(`Read failures are at ${formatPct(overall.rates.readFailure)}.`);
	}
	if (overall.topNoResultQueries.length > 0) {
		insights.failures.push(`Most common dead-end query: ${overall.topNoResultQueries[0].key} (${overall.topNoResultQueries[0].count}x).`);
	}

	if ((overall.rates.searchNoResult ?? 0) >= 0.15) {
		insights.improvements.push("Improve query recovery after no-result searches: relax scope, suggest alternate tokens, or auto-try nearby queries.");
	}
	if ((overall.rates.searchToBashFallbackAfterFailure ?? 0) >= 0.2) {
		insights.improvements.push("Reduce bash fallback by surfacing stronger next-step suggestions directly in grep/find_files output.");
	}
	if ((overall.rates.actionableSearchToRead ?? 1) < 0.35) {
		insights.improvements.push("Search results are not consistently leading to a read; ranking or suggested-read hints likely need work.");
	}
	if ((overall.rates.readFailure ?? 0) >= 0.05) {
		insights.improvements.push("Tighten fuzzy path resolution for read and provide better disambiguation when resolution fails.");
	}
	if ((overall.rates.bashExplorationShare ?? 0) >= 0.15) {
		insights.improvements.push("Agent guidance still leaves room for bash exploration; prompt/tool guidance can push harder toward find_files + grep first.");
	}

	const comparisons = [cohortComparison, timeComparison].filter(Boolean);
	for (const comparison of comparisons) {
		const bashDelta = comparison.deltas.bashExplorationShare?.delta;
		const readDelta = comparison.deltas.actionableSearchToRead?.delta;
		const noResultDelta = comparison.deltas.searchNoResult?.delta;
		if (bashDelta !== null && bashDelta < -0.03) {
			insights.wins.push(`${comparison.right} uses ${formatDelta(bashDelta)} less bash exploration than ${comparison.left}.`);
		}
		if (readDelta !== null && readDelta > 0.05) {
			insights.wins.push(`${comparison.right} improves search→read conversion by ${formatDelta(readDelta)} over ${comparison.left}.`);
		}
		if (noResultDelta !== null && noResultDelta > 0.05) {
			insights.failures.push(`${comparison.right} has a worse no-result rate than ${comparison.left} by ${formatDelta(noResultDelta)}.`);
		}
	}

	if (!insights.wins.length) insights.wins.push("No strong win signal yet; gather more sessions or widen the date range.");
	if (!insights.failures.length) insights.failures.push("No big failure cluster detected in the selected sessions.");
	if (!insights.improvements.length) insights.improvements.push("No obvious heuristic action item crossed the threshold; inspect the top failure examples manually.");
	return insights;
}

function renderComparison(comparison) {
	if (!comparison) return "Comparison\n  - not enough data";
	const lines = [`Comparison: ${comparison.left} → ${comparison.right}`];
	for (const [metric, payload] of Object.entries(comparison.deltas)) {
		lines.push(`  - ${metric}: ${formatPct(payload.left)} → ${formatPct(payload.right)} (${formatDelta(payload.delta)})`);
	}
	return lines.join("\n");
}

function renderStats(stats) {
	return [
		`${stats.label}`,
		`  Sessions: ${stats.sessionCount}`,
		`  Tool calls: ${stats.toolCallCount}`,
		`  Explicit pi-fff calls: ${formatCountPart(stats.explicitFffCallCount, stats.toolCallCount)}`,
		`  Search calls: ${stats.searchCallCount}`,
		`  No-result searches: ${formatCountPart(stats.noResultSearchCallCount, stats.searchCallCount)}`,
		`  Search errors: ${formatCountPart(stats.searchErrorCount, stats.searchCallCount)}`,
		`  Search→read: ${stats.searchCallsLeadingToRead}/${stats.actionableSearchCallCount} (${formatPct(stats.rates.actionableSearchToRead)})`,
		`  Failed search→bash fallback: ${stats.searchCallsLeadingToBashFallback}/${stats.noResultSearchCallCount + stats.searchErrorCount} (${formatPct(stats.rates.searchToBashFallbackAfterFailure)})`,
		`  Failed search→retry: ${stats.searchCallsLeadingToRetry}/${stats.noResultSearchCallCount + stats.searchErrorCount} (${formatPct(stats.rates.searchToRetryAfterFailure)})`,
		`  Bash exploration calls: ${formatCountPart(stats.bashExplorationCallCount, stats.toolCallCount)}`,
		`  Bash search calls: ${formatCountPart(stats.bashSearchCallCount, stats.toolCallCount)}`,
		`  Read failures: ${formatCountPart(stats.readFailureCount, stats.readCallCount)}`,
	].join("\n");
}

function renderInsights(insights) {
	const lines = ["Signals"];
	for (const item of insights.wins) lines.push(`  Win: ${item}`);
	for (const item of insights.failures) lines.push(`  Failure: ${item}`);
	for (const item of insights.improvements) lines.push(`  Improve: ${item}`);
	return lines.join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}

	const filters = {
		cwd: args.cwd,
		after: parseDate(args.after, "start"),
		before: parseDate(args.before, "end"),
	};
	const baselineBefore = parseDate(args.baselineBefore, "end");
	const fffAfter = parseDate(args.fffAfter, "start");

	const sessionFiles = await listJsonlFiles(args.sessionsDir);
	const parsedSessions = [];
	for (const filePath of sessionFiles) {
		const session = await parseSessionFile(filePath);
		if (!includeSession(session, filters)) continue;
		parsedSessions.push(session);
		if (args.maxSessions && parsedSessions.length >= args.maxSessions) break;
	}

	const overall = buildStats("Overall", parsedSessions, args);
	const explicitFffSessions = parsedSessions.filter((session) => session.explicitFff);
	const noExplicitFffSessions = parsedSessions.filter((session) => !session.explicitFff);
	const explicitVsNonExplicit = compareStats(
		"explicit-fff-vs-no-explicit-fff",
		buildStats("No explicit pi-fff tools", noExplicitFffSessions, args),
		buildStats("Explicit pi-fff tools used", explicitFffSessions, args),
	);

	let timeSplit = null;
	if (baselineBefore !== undefined && fffAfter !== undefined) {
		const beforeSessions = parsedSessions.filter((session) => {
			const sessionTime = toTimestampMs(session.timestamp);
			return sessionTime !== undefined && sessionTime <= baselineBefore;
		});
		const afterSessions = parsedSessions.filter((session) => {
			const sessionTime = toTimestampMs(session.timestamp);
			return sessionTime !== undefined && sessionTime >= fffAfter;
		});
		timeSplit = compareStats(
			"time-split",
			buildStats(`Before ${args.baselineBefore}`, beforeSessions, args),
			buildStats(`On/after ${args.fffAfter}`, afterSessions, args),
		);
	}

	const insights = buildInsights(overall, explicitVsNonExplicit, timeSplit);
	const output = {
		selection: {
			sessionsDir: args.sessionsDir,
			cwdFilter: args.cwd ?? null,
			after: args.after ?? null,
			before: args.before ?? null,
			baselineBefore: args.baselineBefore ?? null,
			fffAfter: args.fffAfter ?? null,
			followWindow: args.followWindow,
			matchedSessions: parsedSessions.length,
			explicitFffSessions: explicitFffSessions.length,
			noExplicitFffSessions: noExplicitFffSessions.length,
		},
		overall,
		cohortComparison: explicitVsNonExplicit,
		timeComparison: timeSplit,
		insights,
	};

	if (args.json) {
		console.log(JSON.stringify(output, null, 2));
		return;
	}

	console.log("=".repeat(88));
	console.log("pi sessions × pi-fff analysis");
	console.log("=".repeat(88));
	console.log(`Sessions dir: ${args.sessionsDir}`);
	console.log(`CWD filter: ${args.cwd ?? "(none)"}`);
	console.log(`Matched sessions: ${parsedSessions.length}`);
	console.log(`Explicit pi-fff sessions: ${explicitFffSessions.length}`);
	console.log(`No explicit pi-fff sessions: ${noExplicitFffSessions.length}`);
	console.log();
	console.log(renderStats(overall));
	console.log();
	console.log(renderToolCounts(overall, args.top));
	console.log();
	console.log(renderDurations(overall, Math.min(args.top, 8)));
	console.log();
	console.log(renderComparison(explicitVsNonExplicit));
	if (timeSplit) {
		console.log();
		console.log(renderComparison(timeSplit));
	}
	console.log();
	console.log(renderInsights(insights));
	console.log();
	console.log(renderTopList("Top no-result queries", overall.topNoResultQueries));
	console.log();
	console.log(renderTopList("Top failed-search → bash fallback examples", overall.topFallbackExamples));
	console.log();
	console.log(renderTopList("Top failed-search → retry examples", overall.topRetryExamples));
	console.log();
	console.log(renderTopList("Top read failures", overall.topReadFailures));
	console.log();
	console.log(renderTopList("Top bash exploration commands", overall.topBashCommands));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
