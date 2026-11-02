/**
 * Ruo tool set.
 *
 * Registers the Cursor/Ruo-style tools on top of Ruo's engines:
 * - read_file / list_dir / grep_search / run_terminal_cmd / edit_file translate the
 *   Ruo argument names into Ruo's built-in tool definitions, so truncation,
 *   .gitignore handling, and the file mutation queue keep working. Elevated
 *   execution lives in run_sudo, which risk-scores every command with the
 *   Ruo-1.0-review decisions model before the masked sudo password flow runs.
 * - codebase_search collects candidates with ripgrep, then ranks them with a local
 *   LMH model (the hub exposes no embedding endpoint, so this is lexical
 *   retrieval plus model reranking rather than true vector search).
 * - edit_file maps a sketch onto the file with an apply model, validates the
 *   anchors, then hands them to Ruo's deterministic edit engine.
 * - web_search queries Ruo-1.0, which returns live web results.
 * - fetch_rules serves project rule files; delete_file, file_search, and
 *   diff_history are implemented directly.
 *
 * `reapply` from the Cursor prompt is intentionally absent: Ruo's edit engine
 * applies edits deterministically instead of delegating to a weaker model, so
 * there is no failed-apply state to recover from.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	extractJson,
	resolveRuoTarget,
	RUO_APPLY_MODEL,
	RUO_RERANK_MODEL,
	RUO_STRONG_MODEL,
	RUO_WEB_MODEL,
	ruoChat,
	type RuoTarget,
} from "./ruo-lmh.ts";
import { discoverRules } from "./ruo-prompt.ts";
import { containsSudo, runSudoCommand } from "./sudo-bash.ts";
import { assessSudoRisk, SUDO_MANUAL_APPROVAL_THRESHOLD, sudoCategoryLabel } from "./sudo-review.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
/** Documented read_file limit: at most 250 lines per call. */
const MAX_READ_LINES = 250;
const CODEBASE_SEARCH_CANDIDATES = 40;
const CODEBASE_SEARCH_RESULTS = 12;
const FILE_SEARCH_RESULTS = 10;
const DIFF_HISTORY_COMMITS = 20;

/** `always` prompts for every command, `never` skips prompts, `model` honors require_user_approval. */
const APPROVAL_MODE = (process.env.RUO_APPROVAL ?? process.env.PI_RUO_APPROVAL)?.trim() || "model";

export const RUO_TOOL_NAMES = [
	"codebase_search",
	"read_file",
	"run_terminal_cmd",
	"run_sudo",
	"list_dir",
	"grep_search",
	"edit_file",
	"file_search",
	"delete_file",
	"fetch_rules",
	"web_search",
	"diff_history",
] as const;

export type RuoToolName = (typeof RUO_TOOL_NAMES)[number];

function truncate(text: string, limit = MAX_OUTPUT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= limit) return text;
	const buffer = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8");
	return `${buffer}\n\n[output truncated at ${Math.round(limit / 1024)}KB]`;
}

/** Strip the leading @ some models add to path arguments. */
function normalizePathArg(target: string): string {
	return target.startsWith("@") ? target.slice(1) : target;
}

function resolveToCwd(target: string, cwd: string): string {
	const cleaned = normalizePathArg(target);
	const expanded = cleaned.startsWith("~/") ? path.join(process.env.HOME ?? "", cleaned.slice(2)) : cleaned;
	return path.resolve(cwd, expanded);
}

function workspaceRelative(absolute: string, cwd: string): string {
	const relative = path.relative(cwd, absolute);
	return relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : absolute;
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs = 60_000,
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) child.kill("SIGTERM");
		}, timeoutMs);
		const abort = () => child.kill("SIGTERM");

		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve({ code, stdout, stderr });
		});
	});
}

/** Invoke a Ruo built-in tool definition with translated arguments. */
async function callPiTool(
	definition: ToolDefinition,
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: ExtensionContext,
) {
	return (definition as unknown as ToolDefinition).execute(
		toolCallId,
		params as never,
		signal,
		onUpdate as never,
		ctx,
	);
}

/**
 * Convert a glob such as `**\/*.test.ts` into a RegExp for path filtering.
 *
 * Mirrors ripgrep's `--glob` semantics: a pattern with no `/` is matched against
 * the basename at any depth, so `*.test.ts` excludes `src/deep/a.test.ts`.
 */
function globToRegExp(glob: string): { regex: RegExp; basenameOnly: boolean } {
	const basenameOnly = !glob.includes("/");
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\//g, "\u0000")
		.replace(/\*\*/g, "\u0001")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, "(?:.*/)?")
		.replace(/\u0001/g, ".*");
	return { regex: new RegExp(`^${escaped}$`), basenameOnly };
}

/** Test a workspace-relative path against a glob with ripgrep-like semantics. */
function matchesGlob(relativePath: string, glob: string): boolean {
	const { regex, basenameOnly } = globToRegExp(glob);
	const normalized = relativePath.replace(/^\.\//, "").split(path.sep).join("/");
	if (basenameOnly) {
		const base = normalized.slice(normalized.lastIndexOf("/") + 1);
		return regex.test(base);
	}
	return regex.test(normalized);
}

// ---------------------------------------------------------------------------
// codebase_search retrieval
// ---------------------------------------------------------------------------

interface CodebaseHit {
	path: string;
	line: number;
	text: string;
}

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "how", "what", "why", "does", "are", "was",
	"were", "use", "using", "code", "where", "when", "which", "into", "out", "get", "set", "has",
	"have", "can", "should", "would", "there", "their", "them", "then", "than", "our", "you", "your",
]);

/**
 * Reduce a word to a search stem so inflections still match
 * ("validated" -> "validat", matching "validateToken").
 */
function searchStem(term: string): string {
	const lower = term.toLowerCase();
	for (const suffix of ["ings", "ions", "ing", "ion", "ers", "ies", "ed", "es", "er", "ly", "s"]) {
		if (lower.endsWith(suffix) && lower.length - suffix.length >= 4) {
			const stem = lower.slice(0, lower.length - suffix.length);
			return suffix === "ies" ? `${stem}y` : stem;
		}
	}
	return lower;
}

/** Build a stemmed regex alternation so word variants still match. */
function buildSearchPattern(query: string): string {
	const terms = Array.from(
		new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9_$#.]+/i)
				.filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
				.map(searchStem)
				.filter((term) => term.length >= 3),
		),
	).slice(0, 10);

	if (terms.length === 0) return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return `\\b(?:${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\w*`;
}

/** Collect candidate code snippets with ripgrep. */
async function collectCandidates(
	query: string,
	cwd: string,
	targetDirs: string[] | undefined,
	signal: AbortSignal | undefined,
): Promise<CodebaseHit[]> {
	const pattern = buildSearchPattern(query);
	const searchRoots = (targetDirs && targetDirs.length > 0 ? targetDirs : ["."]).map((dir) =>
		resolveToCwd(dir, cwd),
	);

	try {
		const result = await runCommand(
			"rg",
			[
				"--json",
				"--line-number",
				"--max-count",
				"3",
				"--max-columns",
				"240",
				"--ignore-case",
				"--glob",
				"!**/node_modules/**",
				"--glob",
				"!**/.git/**",
				"--glob",
				"!**/dist/**",
				"--glob",
				"!**/build/**",
				"--glob",
				"!**/*.lock",
				"--glob",
				"!**/*.min.*",
				"--",
				pattern,
				...searchRoots,
			],
			cwd,
			signal,
		);

		const hits: CodebaseHit[] = [];
		for (const line of result.stdout.split("\n")) {
			if (!line.trim()) continue;
			let event: { type?: string; data?: Record<string, unknown> };
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type !== "match" || !event.data) continue;
			const data = event.data as {
				path?: { text?: string };
				line_number?: number;
				lines?: { text?: string };
			};
			const filePath = data.path?.text;
			if (!filePath) continue;
			hits.push({
				path: workspaceRelative(path.resolve(cwd, filePath), cwd),
				line: data.line_number ?? 0,
				text: (data.lines?.text ?? "").replace(/\s+$/, "").slice(0, 240),
			});
			if (hits.length >= CODEBASE_SEARCH_CANDIDATES) break;
		}
		return hits;
	} catch {
		return [];
	}
}

/**
 * Rank candidates with a local model. The hub has no embedding endpoint, so this
 * is lexical retrieval followed by model reranking.
 */
async function rerankCandidates(
	query: string,
	hits: CodebaseHit[],
	target: RuoTarget,
	signal: AbortSignal | undefined,
): Promise<number[]> {
	if (hits.length <= 1) return hits.map((_, index) => index);

	const listing = hits
		.map((hit, index) => `[${index}] ${hit.path}:${hit.line}\n    ${hit.text.trim()}`)
		.join("\n");

	const response = await ruoChat(target, {
		model: RUO_RERANK_MODEL,
		system:
			"You rank code snippets by how useful they are for answering a user's request about a codebase. " +
			'Output ONLY JSON of the shape {"ranking":[index,...]} containing the indexes most relevant first. ' +
			"Include only indexes that are genuinely relevant, at most 8. Output no prose.",
		user: `Request: ${query}\n\nCandidates:\n${listing}`,
		maxTokens: 512,
		signal,
	});

	const parsed = extractJson<{ ranking?: unknown }>(response);
	const ranking = Array.isArray(parsed?.ranking)
		? parsed.ranking
				.map((value) => (typeof value === "number" ? value : Number.parseInt(String(value), 10)))
				.filter((value) => Number.isInteger(value) && value >= 0 && value < hits.length)
		: [];

	if (ranking.length === 0) return hits.map((_, index) => index);
	const seen = new Set(ranking);
	for (let index = 0; index < hits.length; index++) {
		if (!seen.has(index)) ranking.push(index);
	}
	return ranking;
}

// ---------------------------------------------------------------------------
// edit_file: sketch -> exact anchors -> Ruo's deterministic edit engine
// ---------------------------------------------------------------------------

/**
 * The Cursor prompt sends a sketch containing `// ... existing code ...`
 * placeholders. Those placeholders are not part of the file, so ask the apply
 * model to turn the sketch into exact oldText/newText anchors, then let Ruo's
 * deterministic edit engine apply them.
 */
async function sketchToEdits(
	filePath: string,
	fileContent: string,
	instruction: string,
	codeEdit: string,
	target: RuoTarget,
	signal: AbortSignal | undefined,
	model: string,
): Promise<Array<{ oldText: string; newText: string }>> {
	const response = await ruoChat(target, {
		model,
		system:
			"You convert an edit sketch into exact text replacements for a file.\n\n" +
			"Rules:\n" +
			'- Output ONLY valid JSON: {"edits":[{"oldText":"...","newText":"..."}]}\n' +
			"- oldText MUST be copied verbatim from the file content and must appear exactly once.\n" +
			'- Lines reading "// ... existing code ..." are placeholders in the sketch, NOT part of the file. Never include them in oldText or newText.\n' +
			"- Merge each contiguous change into a single edit, and never emit overlapping edits.\n" +
			"- Keep oldText as small as possible while remaining unique.\n" +
			"- New code must be immediately runnable and preserve surrounding indentation exactly.\n" +
			"- If the sketch cannot be mapped onto the file, output {\"edits\":[]} instead of guessing.",
		user: `File: ${filePath}\n\nFile content:\n<<<FILE\n${fileContent}\nFILE>>>\n\nInstruction: ${instruction}\n\nEdit sketch:\n<<<SKETCH\n${codeEdit}\nSKETCH>>>`,
		maxTokens: 4096,
		signal,
	});

	const parsed = extractJson<{ edits?: Array<{ oldText?: unknown; newText?: unknown }> }>(response);
	const edits: Array<{ oldText: string; newText: string }> = [];
	for (const edit of parsed?.edits ?? []) {
		if (typeof edit?.oldText === "string" && typeof edit?.newText === "string" && edit.oldText.length > 0) {
			edits.push({ oldText: edit.oldText, newText: edit.newText });
		}
	}
	return edits;
}

/** Verify each anchor matches exactly once, mirroring Ruo's edit contract. */
function validateAnchors(
	fileContent: string,
	edits: Array<{ oldText: string; newText: string }>,
): string | undefined {
	for (const [index, edit] of edits.entries()) {
		const first = fileContent.indexOf(edit.oldText);
		if (first === -1) {
			return `edit ${index + 1}: oldText was not found in the file; the sketch could not be applied safely.`;
		}
		if (fileContent.indexOf(edit.oldText, first + 1) !== -1) {
			return `edit ${index + 1}: oldText matches multiple locations; a larger anchor is required.`;
		}
	}
	return undefined;
}

/**
 * Phrases the web model uses when it declined to consult live sources. The model
 * is nondeterministic about invoking its search backend, so these responses are
 * retried rather than passed through as an answer.
 */
const WEB_DECLINED_PATTERN =
	/(?:can['\u2019]?t|cannot|unable to|not able to)\s+(?:verify|access|browse|search|check)|no (?:live )?internet access|don['\u2019]?t have (?:access|the ability)/i;

/**
 * Query the live-search model, retrying when it declines to search.
 *
 * The model intermittently answers from memory and claims it cannot reach the
 * web. A declined answer is misleading for a tool whose whole purpose is current
 * information, so retry a couple of times and only then surface the response.
 */
async function runWebSearch(
	query: string,
	target: RuoTarget,
	signal: AbortSignal | undefined,
): Promise<string> {
	const system =
		"You are a web search engine with live internet access. Search the web now, then report the findings concisely " +
		"with the source URLs you actually used. Never claim that you cannot access or verify the web.";
	const attempts = 3;
	let last = "";

	for (let attempt = 0; attempt < attempts; attempt++) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const text = await ruoChat(target, {
			model: RUO_WEB_MODEL,
			system,
			user: attempt === 0 ? query : `${query}\n\nPerform an actual web search and answer from the live results.`,
			maxTokens: 2048,
			signal,
			timeoutMs: Number(process.env.RUO_WEB_TIMEOUT_MS ?? process.env.PI_RUO_WEB_TIMEOUT_MS ?? 180_000),
		});
		last = text;
		if (!WEB_DECLINED_PATTERN.test(text)) return text;
	}

	return last;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function confirmApproval(
	command: string,
	requireUserApproval: boolean | undefined,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (APPROVAL_MODE === "never") return true;
	// Respect an explicit opt-out unless the operator forced approval.
	if (requireUserApproval === false && APPROVAL_MODE !== "always") return true;
	if (!ctx.hasUI || ctx.mode !== "tui") return true;
	return ctx.ui.confirm("Run command?", command);
}

export function registerRuoTools(pi: ExtensionAPI): void {
	// ---------------------------------------------------------------- read_file
	pi.registerTool({
		name: "read_file",
		label: "Read File",
		description:
			"Read the contents of a file. the output of this tool call will be the 1-indexed file contents from start_line_one_indexed to end_line_one_indexed_inclusive, together with a summary of the lines outside start_line_one_indexed and end_line_one_indexed_inclusive.\nNote that this call can view at most 250 lines at a time.\n\nWhen using this tool to gather information, it's your responsibility to ensure you have the COMPLETE context. Specifically, each time you call this command you should:\n1) Assess if the contents you viewed are sufficient to proceed with your task.\n2) Take note of where there are lines not shown.\n3) If the file contents you have viewed are insufficient, and you suspect they may be in lines not shown, proactively call the tool again to view those lines.\n4) When in doubt, call this tool again to gather more information. Remember that partial file views may miss critical dependencies, imports, or functionality.\n\nIn some cases, if reading a range of lines is not enough, you may choose to read the entire file.\nReading entire files is often wasteful and slow, especially for large files (i.e. more than a few hundred lines). So you should use this option sparingly.\nReading the entire file is not allowed in most cases. You are only allowed to read the entire file if it has been edited or manually attached to the conversation by the user.",
		promptSnippet:
			"read_file(target_file, should_read_entire_file, start_line_one_indexed, end_line_one_indexed_inclusive): read file contents",
		promptGuidelines: [
			"Use read_file to examine files instead of cat or sed.",
			"read_file shows at most 250 lines; note the lines not shown and call it again to fill gaps.",
			"Only set read_file should_read_entire_file when the file was edited or attached by the USER.",
		],
		parameters: Type.Object({
			target_file: Type.String({
				description:
					"The path of the file to read. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is.",
			}),
			should_read_entire_file: Type.Boolean({
				description: "Whether to read the entire file. Defaults to false.",
			}),
			start_line_one_indexed: Type.Integer({
				description: "The one-indexed line number to start reading from (inclusive).",
			}),
			end_line_one_indexed_inclusive: Type.Integer({
				description: "The one-indexed line number to end reading at (inclusive).",
			}),
		}),
		executionMode: "parallel",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (
				!params.should_read_entire_file &&
				params.start_line_one_indexed !== undefined &&
				params.end_line_one_indexed_inclusive !== undefined &&
				params.end_line_one_indexed_inclusive < params.start_line_one_indexed
			) {
				throw new Error(
					`read_file: end_line_one_indexed_inclusive (${params.end_line_one_indexed_inclusive}) is before start_line_one_indexed (${params.start_line_one_indexed}).`,
				);
			}
			const offset = params.should_read_entire_file ? undefined : params.start_line_one_indexed;
			const requested =
				params.should_read_entire_file || offset === undefined || params.end_line_one_indexed_inclusive === undefined
					? undefined
					: params.end_line_one_indexed_inclusive - offset + 1;
			// The documented contract is at most MAX_READ_LINES lines per call.
			const limit =
				requested === undefined ? (params.should_read_entire_file ? undefined : MAX_READ_LINES) : Math.min(requested, MAX_READ_LINES);
			return callPiTool(
				createReadToolDefinition(ctx.cwd) as unknown as ToolDefinition,
				toolCallId,
				{ path: params.target_file, offset, limit: limit && limit > 0 ? limit : undefined },
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	// --------------------------------------------------------------- list_dir
	pi.registerTool({
		name: "list_dir",
		label: "List Directory",
		description:
			"List the contents of a directory. The quick tool to use for discovery, before using more targeted tools like semantic search or file reading. Useful to try to understand the file structure before diving deeper into specific files. Can be used to explore the codebase.",
		promptSnippet: "list_dir(relative_workspace_path): list directory contents",
		promptGuidelines: ["Use list_dir for quick discovery of a directory before reading or searching specific files."],
		parameters: Type.Object({
			relative_workspace_path: Type.String({
				description: "Path to list contents of, relative to the workspace root.",
			}),
			explanation: Type.Optional(
				Type.String({
					description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
				}),
			),
		}),
		executionMode: "parallel",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return callPiTool(
				createLsToolDefinition(ctx.cwd) as unknown as ToolDefinition,
				toolCallId,
				{ path: params.relative_workspace_path },
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	// ------------------------------------------------------------- grep_search
	pi.registerTool({
		name: "grep_search",
		label: "Grep Search",
		description:
			"Fast text-based regex search that finds exact pattern matches within files or directories, utilizing the ripgrep command for efficient searching.\nResults will be formatted in the style of ripgrep and can be configured to include line numbers and content.\nTo avoid overwhelming output, the results are capped at 50 matches.\nUse the include or exclude patterns to filter the search scope by file type or specific paths.\n\nThis is best for finding exact text matches or regex patterns.\nMore precise than semantic search for finding specific strings or patterns.\nThis is preferred over semantic search when we know the exact symbol/function name/etc. to search in some set of directories/file types.",
		promptSnippet: "grep_search(query, include_pattern?, exclude_pattern?, case_sensitive?): exact/regex text search",
		promptGuidelines: [
			"Use grep_search for exact text and regex matches; it is more precise than codebase_search for known symbols.",
			"grep_search caps results at 50 matches; narrow the query or add an include_pattern when results are too broad.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The regex pattern to search for" }),
			include_pattern: Type.Optional(
				Type.String({ description: "Glob pattern for files to include (e.g. '*.ts' for TypeScript files)" }),
			),
			exclude_pattern: Type.Optional(Type.String({ description: "Glob pattern for files to exclude" })),
			case_sensitive: Type.Optional(Type.Boolean({ description: "Whether the search should be case sensitive" })),
			explanation: Type.Optional(
				Type.String({
					description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
				}),
			),
		}),
		executionMode: "parallel",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await callPiTool(
				createGrepToolDefinition(ctx.cwd) as unknown as ToolDefinition,
				toolCallId,
				{
					pattern: params.query,
					glob: params.include_pattern,
					ignoreCase: params.case_sensitive === true ? false : true,
				},
				signal,
				undefined,
				ctx,
			);

			if (!params.exclude_pattern) return result;

			// Ruo's grep takes a single include glob, so apply exclusions here.
			const kept = (result.content ?? [])
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("")
				.split("\n")
				.filter((line) => {
					const match = line.match(/^(?:\.[\\/])?(.+?):\d+:/);
					return !match?.[1] || !matchesGlob(match[1], params.exclude_pattern);
				})
				.join("\n")
				.trim();

			return toolResult(kept || `No matches for ${params.query} after excluding ${params.exclude_pattern}.`, {
				excluded: params.exclude_pattern,
			});
		},
	});

	// ----------------------------------------------------------- codebase_search
	pi.registerTool({
		name: "codebase_search",
		label: "Codebase Search",
		description:
			"Find snippets of code from the codebase most relevant to the search query.\nThis is a semantic search tool, so the query should ask for something semantically matching what is needed.\nIf it makes sense to only search in particular directories, please specify them in the target_directories field.\nUnless there is a clear reason to use your own search query, please just reuse the user's exact query with their wording.\nTheir exact wording/phrasing can often be helpful for the semantic search query. Keeping the same exact question format can also be helpful.",
		promptSnippet: "codebase_search(query, target_directories?): find code relevant to a natural-language query",
		promptGuidelines: [
			"Use codebase_search for natural-language or conceptual queries when you do not know the exact symbol name.",
			"Prefer grep_search over codebase_search when you already know the exact string or symbol to find.",
			"Reuse the USER's exact wording as the codebase_search query when there is no clear reason to change it.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"The search query to find relevant code. You should reuse the user's exact query/most recent message with their wording unless there is a clear reason not to.",
			}),
			target_directories: Type.Optional(
				Type.Array(Type.String(), { description: "Glob patterns for directories to search over" }),
			),
			explanation: Type.Optional(
				Type.String({
					description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
				}),
			),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const target = await resolveRuoTarget(ctx);
			const hits = await collectCandidates(params.query, ctx.cwd, params.target_directories, signal);
			if (hits.length === 0) {
				return toolResult(`No code matched the query: ${params.query}`, { results: [] });
			}

			let order: number[];
			try {
				order = await rerankCandidates(params.query, hits, target, signal);
			} catch {
				// Reranking is best-effort; lexical order is still useful.
				order = hits.map((_, index) => index);
			}

			const top = order.slice(0, CODEBASE_SEARCH_RESULTS).map((index) => hits[index]);
			const body = top.map((hit) => `${hit.path}:${hit.line}\n    ${hit.text.trim()}`).join("\n\n");
			return toolResult(`Relevant code for: ${params.query}\n\n${body}`, {
				results: top.map((hit) => ({ path: hit.path, line: hit.line })),
			});
		},
	});

	// ---------------------------------------------------------------- edit_file
	pi.registerTool({
		name: "edit_file",
		label: "Edit File",
		description:
			"Use this tool to propose an edit to an existing file.\n\nThis will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write.\nWhen writing the edit, you should specify each edit in sequence, with the special comment `// ... existing code ...` to represent unchanged code in between edited lines.\n\nFor example:\n\n```\n// ... existing code ...\nFIRST_EDIT\n// ... existing code ...\nSECOND_EDIT\n// ... existing code ...\nTHIRD_EDIT\n// ... existing code ...\n```\n\nYou should still bias towards repeating as few lines of the original file as possible to convey the change.\nBut, each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity.\nDO NOT omit spans of pre-existing code (or comments) without using the `// ... existing code ...` comment to indicate its absence. If you omit the existing code comment, the model may inadvertently delete these lines.\nMake sure it is clear what the edit should be, and where it should be applied.\n\nYou should specify the following arguments before the others: [target_file]",
		promptSnippet:
			"edit_file(target_file, instructions, code_edit): edit a file using a sketch where `// ... existing code ...` marks unchanged regions",
		promptGuidelines: [
			"Use edit_file as the only way to modify existing files; never output code for the USER to apply.",
			"edit_file code_edit must use the `// ... existing code ...` placeholder for every omitted region or those lines will be deleted.",
			"In edit_file code_edit, include enough unchanged context around each change to disambiguate where it applies.",
		],
		parameters: Type.Object({
			target_file: Type.String({
				description:
					"The target file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is.",
			}),
			instructions: Type.String({
				description:
					"A single sentence instruction describing what you are going to do for the sketched edit. This is used to assist the less intelligent model in applying the edit. Please use the first person to describe what you are going to do. Dont repeat what you have said previously in normal messages. And use it to disambiguate uncertainty in the edit.",
			}),
			code_edit: Type.String({
				description:
					"Specify ONLY the precise lines of code that you wish to edit. **NEVER specify or write out unchanged code**. Instead, represent all unchanged code using the comment of the language you're editing in - example: `// ... existing code ...`",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const target = await resolveRuoTarget(ctx);
			const absolute = resolveToCwd(params.target_file, ctx.cwd);

			let fileContent: string;
			try {
				fileContent = await fs.readFile(absolute, "utf8");
			} catch {
				return {
					content: [
						{
							type: "text" as const,
							text: `edit_file could not read ${params.target_file}. Create new files with a write tool, and verify the path before editing.`,
						},
					],
					details: { applied: false },
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text" as const, text: `Applying edit to ${params.target_file}...` }],
				details: undefined,
			});

			const applyModel = RUO_APPLY_MODEL;
			let edits: Array<{ oldText: string; newText: string }> = [];
			let validationError: string | undefined;

			try {
				edits = await sketchToEdits(
					params.target_file,
					fileContent,
					params.instructions,
					params.code_edit,
					target,
					signal,
					applyModel,
				);
				validationError =
					edits.length === 0 ? "the apply model produced no edits." : validateAnchors(fileContent, edits);
			} catch (error) {
				validationError = error instanceof Error ? error.message : String(error);
			}

			// One retry, mirroring the documented "reapply the edit" guidance in the
			// prompt. Sampling is nondeterministic, so a second attempt often resolves a
			// mapping that the first one missed.
			if (validationError) {
				try {
					const retry = await sketchToEdits(
						params.target_file,
						fileContent,
						params.instructions,
						params.code_edit,
						target,
						signal,
						RUO_STRONG_MODEL,
					);
					const retryError =
						retry.length === 0 ? "the apply model produced no edits." : validateAnchors(fileContent, retry);
					if (!retryError) {
						edits = retry;
						validationError = undefined;
					} else {
						validationError = retryError;
					}
				} catch {
					// Keep the original failure.
				}
			}

			if (validationError) {
				// Fail loudly: a mis-anchored sketch would corrupt the file.
				return {
					content: [
						{
							type: "text" as const,
							text: `edit_file could not be applied to ${params.target_file}: ${validationError}\n\nNo changes were written. Re-read the file around the target region, then retry with a smaller, precise code_edit.`,
						},
					],
					details: { applied: false, reason: validationError },
					isError: true,
				};
			}

			const editBase = createEditToolDefinition(ctx.cwd) as unknown as ToolDefinition;
			const result = await callPiTool(
				editBase,
				"edit_file",
				{ path: params.target_file, edits },
				signal,
				undefined,
				ctx,
			);
			return { ...result, details: { ...(result.details as object | undefined), applied: true } };
		},
	});

	// -------------------------------------------------------------- file_search
	pi.registerTool({
		name: "file_search",
		label: "File Search",
		description:
			"Fast file search based on fuzzy matching against file path. Use if you know part of the file path but don't know where it's located exactly. Response will be capped to 10 results. Make your query more specific if need to filter results further.",
		promptSnippet: "file_search(query, explanation): fuzzy file-path search (max 10 results)",
		promptGuidelines: ["Use file_search when you know part of a path but not its exact location."],
		parameters: Type.Object({
			query: Type.String({ description: "Fuzzy filename to search for" }),
			explanation: Type.String({
				description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
			}),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("file_search requires a non-empty query.");

			let result: RunResult;
			try {
				result = await runCommand(
					"fd",
					[
						"--type",
						"f",
						"--hidden",
						"--exclude",
						".git",
						"--exclude",
						"node_modules",
						"--max-results",
						String(FILE_SEARCH_RESULTS),
						"--",
						query,
						ctx.cwd,
					],
					ctx.cwd,
					signal,
				);
			} catch (error) {
				throw new Error(`file_search failed: ${error instanceof Error ? error.message : String(error)}`);
			}

			const paths = result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.slice(0, FILE_SEARCH_RESULTS)
				.map((line) => workspaceRelative(line, ctx.cwd));
			if (paths.length === 0) return toolResult(`No files matched: ${query}`, { paths: [] });
			return toolResult(paths.join("\n"), { paths });
		},
	});

	// ------------------------------------------------------------- delete_file
	pi.registerTool({
		name: "delete_file",
		label: "Delete File",
		description:
			"Deletes a file at the specified path. The operation will fail gracefully if:\n    - The file doesn't exist\n    - The operation is rejected for security reasons\n    - The file cannot be deleted",
		promptSnippet: "delete_file(target_file): delete a file (fails gracefully)",
		promptGuidelines: ["Use delete_file instead of shell rm when removing a file from the workspace."],
		parameters: Type.Object({
			target_file: Type.String({ description: "The path of the file to delete, relative to the workspace root." }),
			explanation: Type.Optional(
				Type.String({
					description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absolute = resolveToCwd(params.target_file, ctx.cwd);
			const relative = workspaceRelative(absolute, ctx.cwd);

			let stats: Awaited<ReturnType<typeof fs.stat>>;
			try {
				stats = await fs.stat(absolute);
			} catch {
				return toolResult(`delete_file: ${relative} does not exist. Nothing to delete.`, { deleted: false });
			}
			if (!stats.isFile()) {
				return {
					content: [{ type: "text" as const, text: `delete_file refused: ${relative} is not a regular file.` }],
					details: { deleted: false },
					isError: true,
				};
			}
			try {
				await fs.rm(absolute);
				return toolResult(`Deleted ${relative}`, { deleted: true });
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `delete_file failed for ${relative}: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { deleted: false },
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------- fetch_rules
	pi.registerTool({
		name: "fetch_rules",
		label: "Fetch Rules",
		description:
			"Fetches rules provided by the user to help with navigating the codebase. Rules contain information about the codebase that can be used to help with generating code. If the users request seems like it would benefit from a rule, use this tool to fetch the rule. Available rules are found in the <available_instructions> section.  Use the key before the colon to refer to the rule",
		promptSnippet: "fetch_rules(rule_names): load project rule files listed in <available_instructions>",
		promptGuidelines: [
			"Use fetch_rules when the USER's request would benefit from project rules listed in <available_instructions>.",
			"fetch_rules takes the key before the colon shown in <available_instructions>.",
		],
		parameters: Type.Object({
			rule_names: Type.Array(Type.String({ description: "The name of the rule to fetch." }), {
				description: "The names of the rules to fetch.",
			}),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rules = discoverRules(ctx.cwd);
			if (rules.length === 0) {
				return toolResult(
					"No project rules were found. Looked for .cursorrules, CLAUDE.md, AGENTS.md, and .cursor/rules.",
					{ rules: [] },
				);
			}
			const requested = params.rule_names ?? [];
			const selected = requested.length > 0 ? rules.filter((rule) => requested.includes(rule.name)) : rules;
			if (selected.length === 0) {
				const available = rules.map((rule) => rule.name).join(", ");
				return toolResult(`No rule matched ${requested.join(", ")}. Available rules: ${available}`, { rules: [] });
			}
			const body = selected
				.map((rule) => `<rule name="${rule.name}">\n${rule.content.trim()}\n</rule>`)
				.join("\n\n");
			return toolResult(body, { rules: selected.map((rule) => rule.name) });
		},
	});

	// -------------------------------------------------------------- web_search
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for real-time information about any topic. Use this tool when you need up-to-date information that might not be available in your training data, or when you need to verify current facts. The search results will include relevant snippets and URLs from web pages. This is particularly useful for questions about current events, technology updates, or any topic that requires recent information.",
		promptSnippet: "web_search(search_term, explanation?): search the web for current information",
		promptGuidelines: [
			"Use web_search when the answer depends on recent or current information that may not be in your training data.",
			"Pass specific keywords and include version numbers or dates in the web_search search_term when relevant.",
		],
		parameters: Type.Object({
			search_term: Type.String({
				description:
					"The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant.",
			}),
			explanation: Type.Optional(
				Type.String({
					description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
				}),
			),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const target = await resolveRuoTarget(ctx);
			const text = await runWebSearch(params.search_term, target, signal);
			return toolResult(text, { searchTerm: params.search_term });
		},
	});

	// ------------------------------------------------------------ diff_history
	pi.registerTool({
		name: "diff_history",
		label: "Diff History",
		description:
			"Retrieve the history of recent changes made to files in the workspace. This tool helps understand what modifications were made recently, providing information about which files were changed, when they were changed, and how many lines were added or removed. Use this tool when you need context about recent modifications to the codebase.",
		promptSnippet: "diff_history(explanation?): recent file changes in the workspace with add/remove counts",
		promptGuidelines: ["Use diff_history to understand recent modifications before changing related code."],
		parameters: Type.Object({
			explanation: Type.Optional(
				Type.String({
					description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
				}),
			),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			try {
				const result = await runCommand(
					"git",
					[
						"log",
						`-${DIFF_HISTORY_COMMITS}`,
						"--numstat",
						"--date=short",
						"--pretty=format:commit %h%x09%ad%x09%an%x09%s",
					],
					ctx.cwd,
					signal,
				);
				if (result.code !== 0) {
					return toolResult(
						`diff_history: not a git workspace, or git failed.\n${truncate(result.stderr.trim(), 1000)}`,
						{ commits: [] },
					);
				}
				const output = result.stdout.trim();
				if (!output) return toolResult("diff_history: no commits found in this workspace.", { commits: [] });
				return toolResult(truncate(output), {});
			} catch (error) {
				return toolResult(`diff_history unavailable: ${error instanceof Error ? error.message : String(error)}`, {
					commits: [],
				});
			}
		},
	});

	// ----------------------------------------------------------- run_terminal_cmd
	pi.registerTool({
		name: "run_terminal_cmd",
		label: "Run Terminal Command",
		description:
			"PROPOSE a command to run on behalf of the user.\nIf you have this tool, note that you DO have the ability to run commands directly on the USER's system.\nNote that the user will have to approve the command before it is executed.\nThe user may reject it if it is not to their liking, or may modify the command before approving it.  If they do change it, take those changes into account.\nThe actual command will NOT execute until the user approves it. The user may not approve it immediately. Do NOT assume the command has started running.\nIf the step is WAITING for user approval, it has NOT started running.\nIn using these tools, adhere to the following guidelines:\n1. Based on the contents of the conversation, you will be told if you are in the same shell as a previous step or a different shell.\n2. If in a new shell, you should `cd` to the appropriate directory and do necessary setup in addition to running the command.\n3. If in the same shell, the state will persist (eg. if you cd in one step, that cwd is persisted next time you invoke this tool).\n4. For ANY commands that would use a pager or require user interaction, you should append ` | cat` to the command (or whatever is appropriate). Otherwise, the command will break. You MUST do this for: git, less, head, tail, more, etc.\n5. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set `is_background` to true rather than changing the details of the command.\n6. Dont include any newlines in the command.",
		promptSnippet: "run_terminal_cmd(command, is_background, require_user_approval, explanation?): run a shell command",
		promptGuidelines: [
			"Use run_terminal_cmd to execute shell commands; it takes command, is_background, and require_user_approval.",
			"Never embed sudo in run_terminal_cmd; use the run_sudo tool for any command that needs root privileges.",
			"Append ` | cat` to run_terminal_cmd commands that would use a pager (git, less, head, tail, more).",
			"Set is_background true for run_terminal_cmd commands that run indefinitely, instead of rewriting the command.",
			"Do not include newlines in a run_terminal_cmd command.",
		],
		parameters: Type.Object({
			command: Type.String({
				description: "The terminal command to execute. Must be a single line; pipe pager commands through ` | cat`.",
			}),
			is_background: Type.Optional(
				Type.Boolean({
					description: "Whether the command should be run in the background. Defaults to false.",
				}),
			),
			require_user_approval: Type.Optional(
				Type.Boolean({
					description:
						"Whether the user must approve the command before it is executed. Defaults to true. Only set this to false if the command is safe and if it matches the user's requirements for commands that should be executed automatically.",
				}),
			),
			explanation: Type.Optional(
				Type.String({
					description: "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const command = params.command.includes("\n") ? params.command.replace(/\s*\n\s*/g, " && ") : params.command;

			if (params.is_background) {
				if (!(await confirmApproval(`[background] ${command}`, params.require_user_approval, ctx))) {
					return toolResult("run_terminal_cmd: the USER rejected this command.", { rejected: true });
				}
				const child = spawn("bash", ["-lc", command], {
					cwd: ctx.cwd,
					env: process.env,
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
				});
				child.unref();
				return toolResult(`Started in background (pid ${child.pid}): ${command}`, {
					background: true,
					pid: child.pid,
				});
			}

			// Elevated execution is owned by run_sudo, which applies the
			// Ruo-1.0-review risk classification before anything runs.
			if (containsSudo(command)) {
				return {
					content: [
						{
							type: "text" as const,
							text: "run_terminal_cmd: this command uses sudo. Use the run_sudo tool instead; it runs the Ruo-1.0-review risk classification and the masked password flow. Do not retry with sudo embedded in run_terminal_cmd.",
						},
					],
					details: { redirected: "run_sudo" },
					isError: true,
				};
			}

			if (!(await confirmApproval(command, params.require_user_approval, ctx))) {
				return toolResult(
					"run_terminal_cmd: the USER rejected this command. Do not retry it unchanged; ask how to proceed.",
					{ rejected: true },
				);
			}

			// Ruo's bash tool reads PI_* session metadata through ctx.sessionManager.
			const bashDefinition = createBashToolDefinition(ctx.cwd, {
				exposeSessionEnvironment: Boolean(ctx.sessionManager),
			}) as unknown as ToolDefinition;
			return callPiTool(bashDefinition, toolCallId, { command }, signal, onUpdate, ctx);
		},
	});

	// --------------------------------------------------------------- run_sudo
	pi.registerTool({
		name: "run_sudo",
		label: "Run Sudo Command",
		description: `PROPOSE a command to run with root (sudo) privileges on the USER's system.\nEvery command is first classified by the Ruo-1.0-review model, which scores its danger from 0 to 100 percent. Commands scoring ${SUDO_MANUAL_APPROVAL_THRESHOLD}% or higher show the USER a summary of the command and require manual approval before anything executes; lower-risk commands run automatically.\nThe sudo password is collected through a masked dialog or the saved credential store; it never appears in chat or on the command line. Never ask the USER to paste a password anywhere.\nIn using this tool, adhere to the following guidelines:\n1. Use run_sudo instead of run_terminal_cmd whenever a command needs elevated privileges; sudo embedded in run_terminal_cmd is rejected.\n2. If the command does not already contain sudo, it is added automatically.\n3. For ANY commands that would use a pager or require user interaction, append \` | cat\` (or whatever is appropriate). Otherwise, the command will break.\n4. Do not include any newlines in the command.\n5. State the irreversible impact, if any, in the explanation so the risk review can classify the command accurately.`,
		promptSnippet: "run_sudo(command, explanation?): run a command with root privileges after an automated risk review",
		promptGuidelines: [
			"Use run_sudo for any command that needs root privileges; never embed sudo in run_terminal_cmd.",
			`Every run_sudo command is risk-scored by the Ruo-1.0-review model; commands at ${SUDO_MANUAL_APPROVAL_THRESHOLD}%+ risk require the USER's manual approval of a summary.`,
			"The sudo password comes from a masked dialog or the saved credential store; never ask the USER to type a password into chat or a command argument.",
			"Append ` | cat` to run_sudo commands that would use a pager, and keep the command on a single line.",
		],
		parameters: Type.Object({
			command: Type.String({
				description:
					"The terminal command to execute with root privileges. Must be a single line; sudo is added automatically when missing.",
			}),
			explanation: Type.Optional(
				Type.String({
					description:
						"One sentence explanation as to why this command needs root privileges and what it changes.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const command = params.command.includes("\n") ? params.command.replace(/\s*\n\s*/g, " && ") : params.command;
			const sudoCommand = containsSudo(command) ? command : `sudo ${command}`;

			// Risk classification first: nothing executes before the review.
			const assessment = await assessSudoRisk(sudoCommand, ctx, signal);
			const details: Record<string, unknown> = {
				risk: assessment.risk,
				threshold: SUDO_MANUAL_APPROVAL_THRESHOLD,
				category: assessment.category,
				confidence: assessment.confidence,
				reviewFailed: assessment.reviewFailed,
			};

			if (assessment.risk >= SUDO_MANUAL_APPROVAL_THRESHOLD) {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					return {
						content: [
							{
								type: "text" as const,
								text: `run_sudo: risk ${assessment.risk}% is at or above the ${SUDO_MANUAL_APPROVAL_THRESHOLD}% threshold and needs manual USER approval, but no interactive UI is available. The command was NOT executed.`,
							},
						],
						details,
						isError: true,
					};
				}
				const summaryLines = [
					`분류: ${sudoCategoryLabel(assessment.category)} · 위험도 ${assessment.risk}%${assessment.confidence !== null ? ` · 신뢰도 ${Math.round(assessment.confidence * 100)}%` : ""}`,
					"",
				];
				if (params.explanation) summaryLines.push(`목적: ${params.explanation}`, "");
				if (assessment.reviewFailed && assessment.failureReason) {
					summaryLines.push(`리뷰 실패(수동 승인 필요): ${assessment.failureReason}`, "");
				}
				summaryLines.push(`명령: ${sudoCommand}`);
				const approved = await ctx.ui.confirm(
					`sudo 명령 승인 · 위험도 ${assessment.risk}%`,
					summaryLines.join("\n"),
				);
				if (!approved) {
					return {
						content: [
							{
								type: "text" as const,
								text: `run_sudo: the USER rejected this command after reviewing the summary (risk ${assessment.risk}%). Do not retry it unchanged; ask how to proceed.`,
							},
						],
						details: { ...details, rejected: true },
						isError: true,
					};
				}
			}

			// Below the threshold (or manually approved): run with the masked
			// password flow. Outside the TUI there is no password dialog, so fall
			// back to Ruo's bash engine (passwordless sudo still works there).
			if (!ctx.hasUI || ctx.mode !== "tui") {
				const bashDefinition = createBashToolDefinition(ctx.cwd, {
					exposeSessionEnvironment: Boolean(ctx.sessionManager),
				}) as unknown as ToolDefinition;
				return callPiTool(bashDefinition, toolCallId, { command: sudoCommand }, signal, onUpdate, ctx);
			}

			let output = "";
			const outcome = await runSudoCommand(
				sudoCommand,
				ctx,
				signal,
				(data) => {
					output += data;
					onUpdate?.({ content: [{ type: "text" as const, text: output }], details });
				},
				undefined,
			);
			if (outcome.canceled) {
				return {
					content: [{ type: "text" as const, text: "run_sudo: sudo command canceled: password was not provided." }],
					details,
					isError: true,
				};
			}
			const text = output || "(no output)";
			const exitCode = outcome.exitCode ?? null;
			return {
				content: [
					{
						type: "text" as const,
						text:
							exitCode === 0
								? `[risk ${assessment.risk}%] ${text}`
								: `[risk ${assessment.risk}%] ${text}\n\nCommand exited with code ${exitCode ?? "unknown"}`,
					},
				],
				details,
				isError: exitCode !== 0,
			};
		},
	});
}
