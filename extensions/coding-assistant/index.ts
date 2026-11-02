import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { createBashToolDefinition, getAgentDir, getMarkdownTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AskUserDialog, type AskUserDialogResult } from "./ask-user-dialog.ts";
import { buildRuoSystemPrompt, discoverRules } from "./ruo-prompt.ts";
import { resolveRuoTarget, RUO_TITLE_MODEL, ruoChat } from "./ruo-lmh.ts";
import { registerRuoTools, RUO_TOOL_NAMES } from "./ruo-tools.ts";
import {
	clearSudoPassword,
	containsSudo,
	promptForSudoPassword,
	runSudoCommand,
	saveSudoPassword,
} from "./sudo-bash.ts";

/**
 * Coding-assistant behavior for Ruo.
 *
 * 1. Replaces Ruo's default system prompt with the Ruo agent prompt, keeping the
 *    dynamic sections that carry project value (rules, project context, skills, cwd).
 *
 * 2. Registers the Ruo/Cursor-style tool set (codebase_search, read_file,
 *    run_terminal_cmd, list_dir, grep_search, edit_file, file_search, delete_file,
 *    fetch_rules, web_search, diff_history) and activates it in main sessions.
 *    Sessions restricted to Ruo's built-in tool names (for example `ultramode`
 *    subagents that spawn `ruo --tools read,grep,find,ls`) keep Ruo's own prompt and
 *    tools untouched so that delegation keeps working.
 *
 * 3. Registers `ask_user`, a clarification tool whose dialog renders the question as
 *    Markdown and shows options with an explicit recommended choice. The last row is
 *    always free-form input, and there is no limit on how many questions can be asked.
 */

/** Marker used by the previous append-style prompt; removed on sight. */
const OLD_APPEND_MARKER = "<!-- pi-coding-assistant-guidelines -->";

/** Tools that only exist in the Ruo set and must not be double-registered by name. */
const RUO_ONLY_TOOLS = new Set<string>(RUO_TOOL_NAMES);

function stripLegacyAppend(prompt: string): string {
	return prompt.replace(new RegExp(`\\n?${OLD_APPEND_MARKER}[\\s\\S]*?${OLD_APPEND_MARKER}\\n?`, "g"), "");
}

/**
 * Accept apostrophe-based fenced code blocks as a Markdown extension.
 *
 * Some models emit `'''bash` / `'''` instead of Markdown's backtick fences.
 * Ruo's Markdown parser correctly handles backticks, so normalize only paired
 * fences at the start of a line and leave ordinary apostrophes untouched.
 */
function normalizeApostropheCodeFences(markdown: string): string {
	const lines = markdown.split("\n");
	let fenceLength: number | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const match = line.match(/^( {0,3})('{3,})(.*)$/);
		if (!match) continue;

		const [, indent, fence, suffix] = match;
		const trimmedSuffix = suffix?.trim() ?? "";
		if (fenceLength === undefined) {
			// Normalize the opening fence immediately. This is important while the
			// assistant is streaming: the closing fence may not have arrived yet.
			// Require an info string (e.g. bash) or a matching closing fence so a
			// normal apostrophe-only line is not changed accidentally.
			const hasClosingFence = lines.slice(i + 1).some((candidate) => {
				const closing = candidate.match(/^ {0,3}('{3,})\s*$/);
				return closing !== null && closing[1].length >= fence.length;
			});
			if (!trimmedSuffix && !hasClosingFence) continue;
			if (trimmedSuffix.startsWith("'") || trimmedSuffix.includes("```")) continue;
			fenceLength = fence.length;
			lines[i] = `${indent}${"`".repeat(fenceLength)}${suffix}`;
		} else if (!trimmedSuffix) {
			lines[i] = `${indent}${"`".repeat(Math.max(fenceLength, fence.length))}`;
			fenceLength = undefined;
		}
	}

	return lines.join("\n");
}

const TITLE_SYSTEM_PROMPT =
	"Generate a concise session title for this coding task. Return only the title, no Markdown, no quotes, no period, maximum 60 characters. Always write the title in the same language as the user's request, not in English unless the user writes in English. Infer the language from the user's natural-language instructions, not from code, file paths, logs, or quoted text. For mixed-language requests, use the main language of the user's instructions. Preserve important technical names and use natural phrasing in that language.";

const CODE_STYLE_GUIDANCE = [
	"<code_style>",
	"Always write idiomatic, maintainable code like an experienced human developer. Follow the project's existing naming, formatting, and architecture. Choose direct solutions; avoid unnecessary abstractions, boilerplate, repetitive guards, and unrelated refactoring. Keep meaningful validation, security checks, and error handling.",
	"Do not add explanatory comments or docstrings to source code. Preserve existing comments and required licenses, shebangs, compiler directives, and tool annotations; do not remove them just to satisfy this rule.",
	"When a code explanation is necessary, write it in a local codere.md at the project root instead of in the source file. Group explanations under headings containing the relative source file path. Each explanation line must use exactly this format: #START~END : explanation, for example #12~18 : explanation. Use actual 1-based line numbers in the final source, including #12~12 for one line, and keep existing explanations accurate when changing their code. Write explanations in the user's language and do not create this file when there is nothing useful to explain.",
	"codere.md is local-only. Before creating it, add the pattern codere.md to the project's .gitignore while preserving existing entries. Never stage, commit, attach, package, publish, or upload it to GitHub or any other external service; explicitly exclude it from archive and deployment inputs as well. If it is already tracked by Git, tell the user and remove only its index entry when authorized, leaving the local file intact. The local Git exclusion added by Ruo is an extra safeguard, not a replacement for upload exclusions.",
	"</code_style>",
].join("\n");

async function configureNewlineKey(): Promise<void> {
	const file = path.join(getAgentDir(), "keybindings.json");
	let bindings: Record<string, string | string[]> = {};
	try {
		bindings = JSON.parse(await fs.readFile(file, "utf8"));
		if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
			throw new Error("Ruo keybindings.json must contain an object.");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const keys = (value: string | string[]) => typeof value === "string" ? [value] : value;
	const newline = keys(bindings["tui.input.newLine"] ?? bindings.newLine ?? ["shift+enter", "ctrl+j"]);
	const filter = keys(bindings["app.session.toggleNamedFilter"] ?? bindings.toggleSessionNamedFilter ?? "ctrl+n");
	const next = {
		...bindings,
		"tui.input.newLine": [...new Set(["ctrl+n", ...newline])],
		"app.session.toggleNamedFilter": [...new Set(filter.map((key) => key === "ctrl+n" ? "alt+n" : key))],
	};
	if (JSON.stringify(next) === JSON.stringify(bindings)) return;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

async function excludeCodeNotesFromGit(cwd: string): Promise<void> {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 3000,
	});
	if (result.status !== 0 || !result.stdout.trim()) return;
	const file = result.stdout.trim();
	let existing = "";
	try {
		existing = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing.split(/\r?\n/).some((line) => line.trim() === "codere.md")) return;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}codere.md\n`);
}
const RETRYABLE_STREAM_INTERRUPTION_PATTERN =
	/^(?:Operation aborted|This operation was aborted|Request was aborted)$/i;
const RETRYABLE_STREAM_ERROR_PATTERN =
	/(?:stream disconnected before completion|stream closed before response\.completed)/i;
let sessionTitleGenerationStarted = false;

/** Normalize a raw title into a single short line. */
function cleanSessionTitle(raw: string): string {
	return raw
		.replace(/[\r\n]+/g, " ")
		.replace(/[`*_#]+/g, "")
		.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60);
}

/**
 * Generate a session title with Ruo-1.0, falling back to the registry model.
 *
 * Ruo-1.0 is only exposed by the LMH hub (not `models.json`), so it is called
 * through the shared LMH client; the registry path remains as a fallback so
 * titles keep working if that hub route is unavailable.
/**
 * Generate a session title with Ruo-1.0.
 *
 * Ruo-1.0 is only exposed by the LMH hub (not `models.json`), so this calls the
 * LMH client directly rather than going through the model registry.
 * Best-effort: failures never block the user's task.
 */
async function generateSessionTitle(prompt: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	if (sessionTitleGenerationStarted || piSessionNameExists(ctx)) return;
	sessionTitleGenerationStarted = true;

	try {
		const target = await resolveRuoTarget(ctx);
		const raw = await ruoChat(target, {
			model: RUO_TITLE_MODEL,
			system: TITLE_SYSTEM_PROMPT,
			user: prompt.slice(0, 4000),
			maxTokens: 64,
			signal: ctx.signal,
			timeoutMs: 30_000,
		});
		const title = cleanSessionTitle(raw);
		if (title) pi.setSessionName(title);
	} catch {
		// Title generation is best-effort and must never block the user's task.
	}
}

function piSessionNameExists(ctx: ExtensionContext): boolean {
	return Boolean(ctx.sessionManager.getSessionName()?.trim());
}

/**
 * Keep `bash` working when the built-in set is active: the Ruo tools supersede it,
 * but the sudo flow is shared so both entry points behave identically.
 */
function registerSudoAwareBash(pi: ExtensionAPI, cwd: string): void {
	const base = createBashToolDefinition(cwd);
	pi.registerTool({
		...base,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!containsSudo(params.command) || !ctx.hasUI || ctx.mode !== "tui") {
				return base.execute(toolCallId, params, signal, onUpdate, ctx);
			}
			let output = "";
			// runSudoCommand loads the saved password or opens the masked dialog,
			// so the secret never reaches the model or the command line.
			const outcome = await runSudoCommand(
				params.command,
				ctx,
				signal,
				(data) => {
					output += data;
					onUpdate?.({ content: [{ type: "text", text: output }], details: undefined });
				},
				params.timeout,
			);
			if (outcome.canceled) {
				return {
					content: [{ type: "text", text: "sudo command canceled: password was not provided." }],
					details: undefined,
					isError: true,
				};
			}
			const text = output || "(no output)";
			const exitCode = outcome.exitCode ?? null;
			return {
				content: [
					{
						type: "text",
						text: exitCode === 0 ? text : `${text}\n\nCommand exited with code ${exitCode ?? "unknown"}`,
					},
				],
				details: undefined,
				isError: exitCode !== 0,
			};
		},
	});
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "A concrete choice shown to the user" }),
	description: Type.Optional(Type.String({ description: "Short explanation of the choice" })),
});

const AskUserParams = Type.Object({
	question: Type.String({
		description: "The focused question to ask the user. Markdown is rendered by the dialog.",
	}),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		description: "At least two concrete choices. The UI always adds a final free-form input row.",
	}),
	recommendedIndex: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Zero-based index of the recommended option. It is preselected and marked as recommended in the dialog.",
		}),
	),
});

interface AskUserDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
}

function secretResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: undefined, isError };
}

/** The secret is never returned in tool content, details, or session entries. */
const SecretParams = Type.Object({
	prompt: Type.String({ description: "Tell the user which key or token to enter (never ask them to paste it into chat)." }),
	target_file: Type.String({ description: "Destination path, shown to the user before entering the secret." }),
	env_key: Type.Optional(Type.String({ description: "For a .env file, the environment variable name to set or replace. Omit to create a new secret-only file." })),
});

function trackedByGit(file: string): boolean {
	const result = spawnSync("git", ["-C", path.dirname(file), "ls-files", "--error-unmatch", "--", path.basename(file)], {
		stdio: "ignore",
		timeout: 3000,
	});
	return result.status === 0;
}

/** Atomic .env update: no intermediate plaintext file with permissive permissions. */
async function saveSecret(file: string, secret: string, envKey?: string): Promise<void> {
	if (trackedByGit(file)) throw new Error("Target is tracked by git; choose an untracked secret file.");
	if (!envKey) {
		const handle = await fs.open(file, "wx", 0o600);
		try {
			await handle.writeFile(`${secret}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return;
	}

	let existing = "";
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Target must be a regular file, not a symlink.");
		existing = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const newline = existing.includes("\r\n") ? "\r\n" : "\n";
	const lines = existing ? existing.split(/\r?\n/) : [];
	if (lines.at(-1) === "") lines.pop();
	const matching = new RegExp(`^\\s*(?:export\\s+)?${envKey}\\s*=`);
	const next = lines.filter((line) => !matching.test(line));
	next.push(`${envKey}=${JSON.stringify(secret)}`);
	const temporary = path.join(path.dirname(file), `.ruo-secret-${process.pid}-${crypto.randomUUID()}`);
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(next.join(newline) + newline, "utf8");
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

const WORKING_LABEL = "Working";
/** `g` 뒤에 붙는 점. 하이라이트가 자기 위를 지나는 동안에만 보인다. */
const WORKING_DOTS = 3;
/** 하이라이트 중심은 -2 에서 시작해 마지막 점까지 훑고 한 바퀴 돈다. */
const WORKING_SPAN = WORKING_LABEL.length + WORKING_DOTS + 2;
const WORKING_GLOW_RADIUS = 2.8;

function workingColor(glow: number): string {
	const r = Math.round(115 + 135 * glow);
	const g = Math.round(130 + 120 * glow);
	const b = Math.round(145 + 105 * glow);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Moving highlight across the letters, rather than a spinner next to static text. */
function workingFrame(step: number): string {
	const center = (step % WORKING_SPAN) - 2;

	const letters = Array.from(WORKING_LABEL, (char, index) => {
		const distance = Math.abs(index - center);
		const glow = Math.max(0, 1 - distance / WORKING_GLOW_RADIUS) ** 2;
		return `${workingColor(glow)}${char}`;
	});

	// 빛이 딱 그 점 위에 있을 때만 반짝한다. 훑고 지나가면 흔적을 남기지 않는다.
	// 숨은 점은 공백으로 두어 메시지 폭이 흔들리지 않게 한다.
	const dots = Array.from({ length: WORKING_DOTS }, (_, index) =>
		center === WORKING_LABEL.length + index ? `${workingColor(1)}.` : " ",
	);

	return [...letters, ...dots].join("") + "\x1b[39m";
}

/**
 * Decide whether this session should use the Ruo prompt and tool set.
 *
 * A session started with an explicit built-in allowlist (`ruo --tools read,grep,find,ls`, or the legacy `pi --tools`,
 * as `ultramode` does for subagents) never has the Ruo tools in its registry, so
 * their absence is the reliable signal to keep Ruo's native prompt and tools.
 *
 * Returns the Ruo tool names that are actually available in this session.
 */
function availableRuoTools(pi: ExtensionAPI): string[] {
	return pi
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name) => RUO_ONLY_TOOLS.has(name));
}

/** True when every Ruo tool is available, i.e. no built-in allowlist excluded them. */
function shouldUseRuoTools(pi: ExtensionAPI): boolean {
	return availableRuoTools(pi).length === RUO_TOOL_NAMES.length;
}

export default async function codingAssistantExtension(pi: ExtensionAPI): Promise<void> {
	await configureNewlineKey();
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	const stopWorking = (ctx: ExtensionContext) => {
		if (workingTimer) clearInterval(workingTimer);
		workingTimer = undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingMessage();
			ctx.ui.setWorkingIndicator();
		}
	};
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || workingTimer) return;
		let step = 0;
		ctx.ui.setWorkingIndicator({ frames: [] });
		ctx.ui.setWorkingMessage(workingFrame(step));
		workingTimer = setInterval(() => ctx.ui.setWorkingMessage(workingFrame(++step)), 95);
	});
	pi.on("agent_settled", (_event, ctx) => stopWorking(ctx));
	pi.on("session_shutdown", (_event, ctx) => stopWorking(ctx));

	pi.registerTool({
		name: "request_secret",
		label: "Request Secret",
		description: "Ask the user for a key or token in a masked dialog and write it directly to a specified file or .env variable. The value is never returned to the model. Only usable in an interactive terminal.",
		promptSnippet: "request_secret(prompt, target_file, env_key?): securely ask for a token and put it in the specified untracked file or .env key",
		promptGuidelines: [
			"Never ask the user to paste a secret into chat, ask_user, or a shell command; use request_secret.",
			"The secret input is not returned to you. Do not read, grep, or print the destination after writing it.",
			"For .env targets specify env_key; otherwise the destination must be a new file. Tell the user the destination before requesting.",
		],
		parameters: SecretParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI || ctx.mode !== "tui") return secretResult("Secret input requires an interactive terminal.", true);
			if (!params.target_file.trim() || params.target_file.includes("\0")) return secretResult("Invalid destination.", true);
			if (params.env_key && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.env_key) || !/^\.env(?:\.[\w.-]+)?$/.test(path.basename(params.target_file)))) {
				return secretResult("env_key requires a valid name and a .env file destination.", true);
			}
			const expanded = params.target_file.startsWith("~/") ? path.join(process.env.HOME ?? ctx.cwd, params.target_file.slice(2)) : params.target_file;
			const file = path.resolve(ctx.cwd, expanded);
			let secret: string | null = null;
			try {
				const directory = await fs.realpath(path.dirname(file));
				const destination = path.join(directory, path.basename(file));
				if (trackedByGit(destination)) throw new Error("Target is tracked by git; choose an untracked secret file.");
				if (!params.env_key) {
					try { await fs.lstat(destination); throw new Error("Target already exists; choose a new secret file."); }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				}
				secret = await ctx.ui.custom<string | null>((tui, theme, _keys, done) => {
					const question = new Markdown(`${params.prompt}\n\n저장 위치: \`${destination}\`${params.env_key ? ` · 키: \`${params.env_key}\`` : ""}`, 0, 0, getMarkdownTheme());
					let value = "";
					return {
						invalidate() { question.invalidate(); },
						dispose() { value = ""; },
						handleInput(data: string) {
							if (matchesKey(data, Key.escape)) { value = ""; done(null); return; }
							if (matchesKey(data, Key.enter)) { const answer = value; value = ""; done(answer || null); return; }
							if (matchesKey(data, Key.backspace)) value = Array.from(value).slice(0, -1).join("");
							else value += Array.from(data).filter((char) => { const cp = char.codePointAt(0) ?? 0; return cp >= 32 && cp !== 127; }).join("");
							tui.requestRender();
						},
						render(width: number) {
							const w = Math.max(1, width);
							const border = theme.fg("accent", "─".repeat(w));
							return [border, ...question.render(w).map((line) => truncateToWidth(line, w, "")), border,
								truncateToWidth(`  ${"•".repeat(Math.max(0, Math.min(Array.from(value).length, w - 2)))}`, w, ""),
								truncateToWidth(theme.fg("dim", "입력값은 숨겨집니다 · Enter 저장 · Esc 취소"), w, ""), border];
						},
					};
				});
				if (!secret || signal?.aborted) return secretResult("Secret entry canceled; nothing was saved.");
				await saveSecret(destination, secret, params.env_key);
				return secretResult(`Secret saved to ${destination}${params.env_key ? ` (${params.env_key})` : ""}. Value not returned. Do not read or print this file.`);
			} catch (error) {
				return secretResult(`Secret was not saved: ${error instanceof Error ? error.message : "unknown error"}`, true);
			} finally {
				secret = null;
			}
		},
	});

	pi.registerCommand("sudop", {
		description: "Save the sudo password in ~/.ruo/agent/sudo-password.json",
		handler: async (_args, ctx) => {
			const password = await promptForSudoPassword(ctx);
			if (!password) {
				ctx.ui.notify("sudo password was not saved.", "warning");
				return;
			}
			saveSudoPassword(password);
			ctx.ui.notify("sudo password saved (mode 0600).", "info");
		},
	});

	pi.registerCommand("sudo-clear", {
		description: "Delete the saved sudo password",
		handler: async (_args, ctx) => {
			clearSudoPassword();
			ctx.ui.notify("Saved sudo password deleted.", "info");
		},
	});

	pi.registerMarkdownTransformer((markdown) => normalizeApostropheCodeFences(markdown));

	// Register the Ruo tool set once; activation is decided per session.
	const webAccessInstalled = SettingsManager.create(process.cwd(), getAgentDir()).getPackages().some((entry) => {
		const source = typeof entry === "string" ? entry : entry.source;
		return /^npm:pi-web-access(?:@|$)/.test(source);
	});
	registerRuoTools(webAccessInstalled ? {
		...pi,
		registerTool(tool) {
			if (tool.name !== "web_search") pi.registerTool(tool);
		},
	} : pi);

	pi.on("session_start", async (_event, ctx) => {
		sessionTitleGenerationStarted = false;
		try {
			await excludeCodeNotesFromGit(ctx.cwd);
		} catch {
			ctx.ui.notify("codere.md의 로컬 Git 제외 설정을 적용하지 못했습니다. 업로드 전에 제외 여부를 확인하세요.", "warning");
		}
		registerSudoAwareBash(pi, ctx.cwd);

		if (!shouldUseRuoTools(pi)) return;

		// Present exactly the Ruo surface, plus the session-level helpers that the
		// Ruo prompt documents. `bash` is deliberately not activated: `run_terminal_cmd`
		// owns shell access (and carries the shared sudo flow), so exposing `bash` as
		// well would give the model an undocumented second path. Ruo's other built-ins
		// (read/edit/write/grep/find/ls) are hidden for the same reason.
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const wanted = [...RUO_TOOL_NAMES, "ask_user", "request_secret", "subagent", "fetch_content", "get_search_content", "source_check", "web_enable"];
		pi.setActiveTools(wanted.filter((name) => available.has(name)));
	});

	// Ruo's built-in retry classifier deliberately treats an aborted assistant
	// response as terminal. Provider-side stream drops can nevertheless arrive
	// with an aborted stop reason, so normalize only those provider interruptions
	// to a retryable error. User-triggered Esc/Ctrl+C aborts have no provider
	// error text and remain terminal.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		// Do not turn an intentional Esc/Ctrl+C cancellation into a retry.
		if (ctx.signal?.aborted) return;

		const errorMessage = message.errorMessage?.trim() ?? "";
		const interruptedAbort =
			message.stopReason === "aborted" && RETRYABLE_STREAM_INTERRUPTION_PATTERN.test(errorMessage);
		const interruptedError =
			message.stopReason === "error" && RETRYABLE_STREAM_ERROR_PATTERN.test(errorMessage);
		if (!interruptedAbort && !interruptedError) return;

		// Ruo retries transient errors, but treats `aborted` as terminal and does
		// not classify this provider's early stream-close wording as retryable.
		// Normalize only provider-side interruptions into the existing retry path.
		return {
			message: {
				...message,
				stopReason: "error",
				errorMessage: `network error: stream interrupted: ${errorMessage}`,
			},
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		void generateSessionTitle(event.prompt, ctx, pi);

		// Subagent runs use an explicit built-in allowlist, so the Ruo tools are
		// absent; leave those sessions on Ruo's own prompt.
		if (!shouldUseRuoTools(pi)) {
			return { systemPrompt: `${stripLegacyAppend(event.systemPrompt)}\n\n${CODE_STYLE_GUIDANCE}` };
		}

		const activeTools = pi.getActiveTools();
		const modelName = ctx.model?.id ?? ctx.model?.name ?? "an unknown model";
		const systemPrompt = buildRuoSystemPrompt({
			modelName,
			cwd: ctx.cwd,
			rules: discoverRules(ctx.cwd),
			contextFiles: event.systemPromptOptions?.contextFiles ?? [],
			skills: event.systemPromptOptions?.skills ?? [],
			availableTools: activeTools.filter((name) => !RUO_ONLY_TOOLS.has(name)),
		});
		return { systemPrompt: `${systemPrompt}\n\n${CODE_STYLE_GUIDANCE}\n\nWhen a key or token is needed, use request_secret to ask through the masked UI and write it to an untracked destination. Never request it through chat or ask_user, and never inspect the destination after saving.` };
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a focused clarification question when an important decision is ambiguous. The question is rendered as Markdown. Provide at least two concrete options; the recommended option is preselected and labeled. The UI always provides a final free-form input row.",
		promptSnippet: "ask_user(question, options, recommendedIndex): ask the user to choose or provide a custom answer",
		promptGuidelines: [
			"Use ask_user when an ambiguity can materially change the implementation; do not guess consequential requirements.",
			"Provide at least two concrete choices and set recommendedIndex when one choice is preferred.",
			"ask_user renders the question as Markdown; inline code, short lists, and brief sections are supported.",
			"The final row is always free-form input, so do not add a fake custom-input option yourself.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const detailsBase = {
				question: params.question,
				options: params.options.map((option) => option.label),
			};

			if (!ctx.hasUI || ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "Unable to ask the user: interactive UI is not available. Do not make a consequential assumption; explain what decision is required.",
						},
					],
					details: { ...detailsBase, answer: null, wasCustom: false } satisfies AskUserDetails,
					isError: true,
				};
			}

			if (params.options.length < 2) {
				return {
					content: [{ type: "text", text: "ask_user requires at least two concrete options." }],
					details: { ...detailsBase, answer: null, wasCustom: false } satisfies AskUserDetails,
					isError: true,
				};
			}

			const recommendedIndex =
				params.recommendedIndex !== undefined &&
				params.recommendedIndex >= 0 &&
				params.recommendedIndex < params.options.length
					? params.recommendedIndex
					: undefined;

			const result = await ctx.ui.custom<AskUserDialogResult | null>((tui, theme, _keybindings, done) => {
				return new AskUserDialog({
					tui,
					theme,
					markdownTheme: getMarkdownTheme(),
					question: params.question,
					options: params.options,
					recommendedIndex,
					done,
				});
			});

			if (!result) {
				return {
					content: [{ type: "text", text: "The user canceled the question. Wait for further instructions." }],
					details: { ...detailsBase, answer: null, wasCustom: false } satisfies AskUserDetails,
				};
			}

			return {
				content: [{ type: "text", text: `User selected: ${result.answer}` }],
				details: { ...detailsBase, answer: result.answer, wasCustom: result.wasCustom } satisfies AskUserDetails,
			};
		},
	});
}
