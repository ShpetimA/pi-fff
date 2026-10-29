import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions, TUI } from "@mariozechner/pi-tui";
import type { EditorTheme } from "@mariozechner/pi-tui";
import type { FffRuntime } from "./fff.ts";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const MAX_RESULTS = 20;

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
	}
	return -1;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) quoteStart = i;
		}
	}
	return inQuotes ? quoteStart : null;
}

function extractAtPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart !== null && quoteStart > 0 && text[quoteStart - 1] === "@" && isTokenStart(text, quoteStart - 1)) {
		return text.slice(quoteStart - 1);
	}

	const lastDelimiterIndex = findLastDelimiter(text);
	const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
	if (text[tokenStart] === "@") return text.slice(tokenStart);
	return null;
}

function parseAtPrefix(prefix: string): { rawQuery: string; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) return { rawQuery: prefix.slice(2), isQuotedPrefix: true };
	return { rawQuery: prefix.slice(1), isQuotedPrefix: false };
}

function normalizeInsertedPath(value: string): string {
	let normalized = value.trim();
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized.startsWith('"') && normalized.endsWith('"') && normalized.length >= 2) {
		normalized = normalized.slice(1, -1);
	}
	return normalized;
}

function toSuggestion(relativePath: string, label: string, description: string, isQuotedPrefix: boolean): AutocompleteItem {
	const path = relativePath.replace(/\\/g, "/");
	const needsQuotes = isQuotedPrefix || path.includes(" ");
	return {
		value: needsQuotes ? `@"${path}"` : `@${path}`,
		label,
		description,
	};
}

/**
 * Hosts disagree on the 4th `getSuggestions` argument: pi passes
 * `{ signal, force? }`, while omp passes the bare `AbortSignal` (plus an
 * `onPartial` callback). Accept both — reading `.signal` off a bare
 * AbortSignal throws, and a throwing provider makes the host cancel
 * autocomplete outright, which silently kills the `@` popup.
 */
type AutocompleteSignalArg = AbortSignal | { signal?: AbortSignal; force?: boolean } | undefined;

function resolveSignal(arg: unknown): AbortSignal | undefined {
	if (!arg) return undefined;
	if (typeof (arg as AbortSignal).aborted === "boolean") return arg as AbortSignal;
	return (arg as { signal?: AbortSignal }).signal;
}

export class FffAtAutocompleteProvider implements AutocompleteProvider {
	readonly #baseProvider: AutocompleteProvider;
	readonly #runtime: FffRuntime;

	constructor(baseProvider: AutocompleteProvider, runtime: FffRuntime) {
		this.#baseProvider = baseProvider;
		this.#runtime = runtime;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signalOrOptions: AutocompleteSignalArg,
	): Promise<AutocompleteSuggestions | null> {
		const signal = resolveSignal(signalOrOptions);
		// Forward the argument untouched: whatever shape the host sent is the shape
		// its own base provider expects.
		const forward = () =>
			this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol, signalOrOptions as { signal: AbortSignal });
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const atPrefix = extractAtPrefix(textBeforeCursor);
		if (!atPrefix) return forward();
		if (signal?.aborted) return null;

		const { rawQuery, isQuotedPrefix } = parseAtPrefix(atPrefix);
		const candidatesResult = await this.#runtime.searchFileCandidates(rawQuery, MAX_RESULTS);
		if (signal?.aborted || candidatesResult.isErr() || candidatesResult.value.length === 0) {
			return forward();
		}

		return {
			prefix: atPrefix,
			items: candidatesResult.value.map((candidate) => {
				const matchType = candidate.score?.matchType ? ` · ${candidate.score.matchType}` : "";
				return toSuggestion(
					candidate.item.relativePath,
					candidate.item.fileName || candidate.item.relativePath,
					`${candidate.item.relativePath}${matchType}`,
					isQuotedPrefix,
				);
			}),
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		void this.#runtime.trackQuery(prefix, normalizeInsertedPath(item.value));
		return this.#baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const candidate = this.#baseProvider as AutocompleteProvider & {
			shouldTriggerFileCompletion?: (l: string[], line: number, col: number) => boolean;
		};
		return candidate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	}
}

export class FffEditor extends CustomEditor {
	readonly #runtime: FffRuntime;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, runtime: FffRuntime) {
		super(tui, theme, keybindings);
		this.#runtime = runtime;
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(new FffAtAutocompleteProvider(provider, this.#runtime));
	}
}
