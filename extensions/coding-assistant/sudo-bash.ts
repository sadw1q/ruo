/**
 * Sudo-aware bash execution shared by the `bash` tool and Ruo's
 * `run_terminal_cmd` tool.
 *
 * The password never reaches the model: it is read from a 0600 file or a masked
 * TUI dialog, then written to the child's stdin instead of the command line.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SudoPasswordDialog } from "./sudo-password-dialog.ts";

const SUDO_PASSWORD_FILE = "sudo-password.json";

export function getSudoPasswordPath(): string {
	return path.join(getAgentDir(), SUDO_PASSWORD_FILE);
}

export function loadSavedSudoPassword(): string | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(getSudoPasswordPath(), "utf8")) as { password?: unknown };
		return typeof parsed.password === "string" && parsed.password.length > 0 ? parsed.password : null;
	} catch {
		return null;
	}
}

export function saveSudoPassword(password: string): void {
	const filePath = getSudoPasswordPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(filePath, `${JSON.stringify({ password })}\n`, { encoding: "utf8", mode: 0o600 });
	fs.chmodSync(filePath, 0o600);
}

export function clearSudoPassword(): void {
	try {
		fs.rmSync(getSudoPasswordPath(), { force: true });
	} catch {
		// Best effort cleanup.
	}
}

export async function promptForSudoPassword(ctx: ExtensionContext): Promise<string | null> {
	if (!ctx.hasUI || ctx.mode !== "tui") return null;
	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => new SudoPasswordDialog(tui, theme, done));
}

export function containsSudo(command: string): boolean {
	return /(?:^|[;&|()\s])sudo(?=\s|$)/.test(command);
}

export function addSudoStdinMode(command: string): string {
	return command.replace(/(?:^|[;&|()\s])sudo(?=\s|$)/, (match) => `${match} -S -p ''`);
}

export async function executeWithSudoPassword(
	command: string,
	cwd: string,
	password: string,
	signal: AbortSignal | undefined,
	onData: (data: string) => void,
	timeoutSeconds: number | undefined,
): Promise<number | null> {
	const child = spawn("bash", ["-lc", addSudoStdinMode(command)], {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abort = () => {
		if (!child.killed) child.kill("SIGTERM");
	};
	child.stdout.on("data", (data) => onData(data.toString()));
	child.stderr.on("data", (data) => onData(data.toString()));
	child.stdin.on("error", () => {});
	child.stdin.end(`${password}\n`);
	if (signal) {
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	}
	if (timeoutSeconds && timeoutSeconds > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			abort();
		}, timeoutSeconds * 1000);
	}
	try {
		return await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(timedOut ? null : code));
		});
	} finally {
		if (timer) clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", abort);
	}
}

export interface SudoRunOutcome {
	/** Set when the command was handled here; undefined means "run normally". */
	text?: string;
	exitCode?: number | null;
	canceled?: boolean;
}

/**
 * Run a command that contains `sudo`, prompting for the password when needed.
 * Returns `canceled` when the user dismisses the dialog so the caller can report it.
 */
export async function runSudoCommand(
	command: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onData: (data: string) => void,
	timeoutSeconds: number | undefined,
): Promise<SudoRunOutcome> {
	if (!containsSudo(command) || !ctx.hasUI || ctx.mode !== "tui") return {};

	let password = loadSavedSudoPassword();
	if (!password) password = await promptForSudoPassword(ctx);
	if (!password) return { canceled: true };

	try {
		const exitCode = await executeWithSudoPassword(command, ctx.cwd, password, signal, onData, timeoutSeconds);
		return { exitCode };
	} finally {
		// Do not retain the secret longer than the command execution.
		password = "";
	}
}
