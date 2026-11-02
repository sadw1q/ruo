/**
 * UltraFooter
 *
 * 기본 푸터와 유사한 정보(경로/브랜치/토큰 통계/컨텍스트/모델명)를 보여주고,
 * 모델명 아래 줄에 다음을 표시한다.
 *  - 실시간 TPS(초당 출력 토큰)
 *  - 모드 상태(ULTRAMODE / FAST)
 *  - 동작 중인 서브에이전트 ("Sub Agent is working")
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { formatDisplayTokens, unknownTokens, type DisplayTokens, type SubagentState } from "./subagent-usage.ts";

export interface UltraFooterModel {
	id: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
}

export interface UltraSubagent {
	index?: number;
	state?: SubagentState;
	displayTokens?: DisplayTokens;
	agent: string;
	task: string;
	elapsedMs: number;
}

export interface UltraFooterProvider {
	getEntries(): any[];
	getCwd(): string;
	getSessionName(): string | undefined;
	getModel(): UltraFooterModel | undefined;
	getThinkingLevel(): string | undefined;
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	getTps(): number | null;
	isStreaming(): boolean;
	/** 활성 모드 라벨 (예: ["ULTRAMODE", "FAST"]). */
	getModeLabels(): string[];
	/** 현재 동작 중인 서브에이전트들. */
	getSubagents(): UltraSubagent[];
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${s % 60}s`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
	return cwd;
}

/** 좌측/우측 텍스트를 주어진 폭에 맞춰 정렬한다. */
function composeLine(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + rw + 1 <= width) {
		return left + " ".repeat(width - lw - rw) + right;
	}
	if (rw + 2 >= width) {
		return truncateToWidth(right, width, "");
	}
	const avail = Math.max(0, width - rw - 1);
	const truncated = truncateToWidth(left, avail, "...");
	const tw = visibleWidth(truncated);
	return truncated + " ".repeat(Math.max(1, width - tw - rw)) + right;
}

function rightOnly(text: string, width: number): string {
	const tw = visibleWidth(text);
	if (tw >= width) return truncateToWidth(text, width, "");
	return " ".repeat(width - tw) + text;
}

/** 서브에이전트 스피너 프레임. */
const SUB_SPINNER = ["◐", "◓", "◑", "◒"];

export class UltraFooter {
	private tui: any;
	private theme: any;
	private footerData: any;
	private provider: UltraFooterProvider;
	private unsubscribe?: () => void;
	private spinnerFrame = 0;

	constructor(tui: any, theme: any, footerData: any, provider: UltraFooterProvider) {
		this.tui = tui;
		this.theme = theme;
		this.footerData = footerData;
		this.provider = provider;
		this.unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
	}

	invalidate(): void {}

	/** 스피너 프레임을 진행시킨다 (서브에이전트 동작 중 애니메이션). */
	tickSpinner(): void {
		this.spinnerFrame = (this.spinnerFrame + 1) % SUB_SPINNER.length;
	}

	dispose(): void {
		this.unsubscribe?.();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const entries = this.provider.getEntries();

		// 누적 토큰/비용 통계
		let input = 0,
			output = 0,
			cacheRead = 0,
			cacheWrite = 0,
			cost = 0;
		let latestCacheHitRate: number | undefined;
		for (const entry of entries) {
			let usage: any;
			if (entry.type === "message" && entry.message?.role === "assistant") usage = entry.message.usage;
			else if (entry.type === "message" && entry.message?.role === "toolResult") usage = entry.message.usage;
			else if (entry.type === "branch_summary" || entry.type === "compaction") usage = entry.usage;
			if (!usage) continue;
			input += usage.input || 0;
			output += usage.output || 0;
			cacheRead += usage.cacheRead || 0;
			cacheWrite += usage.cacheWrite || 0;
			cost += usage.cost?.total || 0;
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const prompt = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
				latestCacheHitRate = prompt > 0 ? ((usage.cacheRead || 0) / prompt) * 100 : latestCacheHitRate;
			}
		}

		const model = this.provider.getModel();
		const contextUsage = this.provider.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
		const percentValue = contextUsage?.percent ?? 0;
		const contextPercent =
			contextUsage?.percent !== null && contextUsage?.percent !== undefined
				? `${percentValue.toFixed(1)}%/${formatTokens(contextWindow)}`
				: `?/${formatTokens(contextWindow)}`;

		// 첫 줄: 경로 (+브랜치, +세션명)
		let pwd = formatCwd(this.provider.getCwd());
		const branch = this.footerData.getGitBranch?.();
		if (branch) pwd += ` (${branch})`;
		const sessionName = this.provider.getSessionName();
		if (sessionName) pwd += ` • ${sessionName}`;

		// 둘째 줄: 토큰 통계 + 컨텍스트 (좌), 모델명 + 모드 라벨 (우)
		const stats: string[] = [];
		stats.push(theme.fg("muted", `IN ↑${formatTokens(input)}`));
		stats.push(theme.fg("muted", `OUT ↓${formatTokens(output)}`));
		if (cacheRead) stats.push(theme.fg("dim", `R${formatTokens(cacheRead)}`));
		if (cacheWrite) stats.push(theme.fg("dim", `W${formatTokens(cacheWrite)}`));
		if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
			stats.push(theme.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`));
		}
		if (cost) stats.push(theme.fg("dim", `$${cost.toFixed(3)}`));
		if (percentValue > 90) stats.push(theme.fg("error", contextPercent));
		else if (percentValue > 70) stats.push(theme.fg("warning", contextPercent));
		else stats.push(theme.fg("dim", contextPercent));
		const statsLeft = stats.join(" ");

		// 우측: 모델명 + 모드 상태 (예: "gpt-6-astra • medium  ULTRAMODE")
		let rightSide = model ? model.id : "no-model";
		if (model?.reasoning) {
			const level = this.provider.getThinkingLevel() || "off";
			rightSide = level === "off" ? `${rightSide} • thinking off` : `${rightSide} • ${level}`;
		}
		if (model && this.footerData.getAvailableProviderCount?.() > 1) {
			const withProvider = `(${model.provider}) ${rightSide}`;
			if (visibleWidth(statsLeft) + visibleWidth(withProvider) + 1 <= width) {
				rightSide = withProvider;
			}
		}

		const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."))];
		if (visibleWidth(statsLeft) + visibleWidth(rightSide) + 1 <= width) {
			lines.push(composeLine(statsLeft, theme.fg("dim", rightSide), width));
		} else {
			lines.push(...wrapTextWithAnsi(statsLeft, Math.max(1, width)));
			lines.push(rightOnly(theme.fg("dim", rightSide), width));
		}

		// TPS 는 모델명 아래 우측 정렬로 표시한다.
		const tps = this.provider.getTps();
		if (tps !== null && tps !== undefined && Number.isFinite(tps)) {
			const streaming = this.provider.isStreaming();
			const text = `⚡ ${tps.toFixed(1)} tok/s`;
			const colored = streaming ? theme.fg("accent", text) : theme.fg("dim", text);
			lines.push(rightOnly(colored, width));
		}

		// 상태 줄: 모드 라벨(ULTRAMODE / FAST) 옆에 동작 중인 서브에이전트를 붙인다.
		const modeLabels = this.provider.getModeLabels();
		const modeStr = modeLabels.length > 0 ? theme.fg("accent", modeLabels.join(" ")) : "";

		const subagents = this.provider.getSubagents();

		// 다른 확장의 상태 표시 (ultramode 키는 위에서 직접 렌더하므로 제외)
		const statuses = this.footerData.getExtensionStatuses?.();
		const others: string[] = [];
		if (statuses) {
			for (const [key, text] of statuses.entries()) {
				if (key === "ultramode") continue;
				others.push(String(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
			}
		}

		const infoParts = [modeStr, ...others].filter((s) => s.length > 0);
		if (infoParts.length > 0) {
			lines.push(truncateToWidth(infoParts.join("   "), width, theme.fg("dim", "...")));
		}

		for (const s of subagents) {
			const state = s.state ?? "running";
			const icon = state === "running" ? SUB_SPINNER[this.spinnerFrame % SUB_SPINNER.length]! : state === "queued" ? "○" : state === "failed" ? "✗" : "✓";
			const name = `${s.agent}${s.index !== undefined ? ` #${s.index + 1}` : ""}`.replace(/[\r\n\t]/g, " ");
			const text = `${theme.fg("accent", `${icon} ${name}`)} ${theme.fg("muted", formatDisplayTokens(s.displayTokens ?? unknownTokens()))} ${theme.fg("dim", `· ${state} · ${formatElapsed(s.elapsedMs)}`)}`;
			lines.push(...wrapTextWithAnsi(text, Math.max(1, width)));
		}

		return lines;
	}
}
