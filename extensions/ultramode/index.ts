/**
 * ULTRAMODE Extension
 *
 * 명령어
 *  - `/ultramode` : 서브에이전트 도구 활성화 + 강한 사용 가이드 주입 + 테두리 RGB 무지개
 *  - `/fast`      : 빠른 응답 모드 (추론 강도 low + service_tier=priority)
 *
 * 입력창
 *  - 항상 네모 박스 + 글래스(반사/광택) 효과로 감싼다.
 *    테두리 기본 색은 추론 강도(thinking level)에 따라 pi가 지정하는 색을 그대로 쓴다.
 *  - ULTRAMODE 활성 시 그 색 위에 RGB 무지개가 흐른다.
 *
 * FAST 테두리
 *  - `/fast` 활성 상태에서는 입력창 테두리에 RGB 무지개가 계속 흐른다.
 *
 * 푸터
 *  - 모델명 아래 줄에 실시간 TPS(초당 출력 토큰)를 표시한다.
 *  - 모드 상태(ULTRAMODE / FAST)와 동작 중인 서브에이전트를 표시한다.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import subagentExtension from "./subagent.ts";
import { discoverAgents } from "./agents.ts";
import { UltraEditor } from "./ultra-editor.ts";
import { UltraFooter, type UltraFooterProvider } from "./footer.ts";
import { unknownTokens, resultTokens, resultState, type DisplayTokens, type SubagentState } from "./subagent-usage.ts";

const TOOL_NAME = "subagent";
const STATUS_KEY = "ultramode";
const CONTEXT_TYPE = "ultramode-context";
const STATE_TYPE = "ultramode";

const FRAME_MS = 80; // 입력창 애니메이션 프레임 간격
const PHASE_STEP = 14; // 프레임당 RGB 위상 이동(도)
const SHINE_STEP = 0.009; // 프레임당 글래스 하이라이트 이동

const FAST_THINKING_LEVEL = "low"; // fast 모드에서 사용할 추론 강도
const FAST_SERVICE_TIER = "priority"; // fast 모드에서 요청할 서비스 티어

const TPS_WINDOW_MS = 2500;
const TPS_REDRAW_MS = 200;

/** 진행 중인 서브에이전트 작업 추적. */
interface RunningSubagent {
	index: number;
	state: SubagentState;
	displayTokens: DisplayTokens;
	elapsedMs?: number;
	agent: string;
	task: string;
	startedAt: number;
}

export default function ultramodeExtension(pi: ExtensionAPI): void {
	// 서브에이전트 도구를 이 확장에서 직접 등록한다.
	subagentExtension(pi);

	let ultra = false; // ULTRAMODE (RGB + 서브에이전트)
	let fast = false; // FAST 모드
	let toolsBeforeEnable: string[] | undefined;
	let thinkingBeforeFast: ReturnType<typeof pi.getThinkingLevel> | undefined;

	let editor: UltraEditor | undefined;
	let animTimer: ReturnType<typeof setInterval> | undefined;
	let footerCtx: ExtensionContext | undefined;
	let footer: UltraFooter | undefined;
	let subagentTimer: ReturnType<typeof setInterval> | undefined;
	let footerRender: (() => void) | undefined;

	/** 실행 중인 서브에이전트 (toolCallId -> 정보). */
	const runningSubagents = new Map<string, RunningSubagent[]>();

	/* ------------------------------ editor ----------------------------- */

	function refreshEditorLabel(): void {
		const parts: string[] = [];
		if (ultra) parts.push("ULTRA MODE");
		if (fast) parts.push("FAST");
		editor?.setLabel(parts.length > 0 ? ` ${parts.join(" · ")} ` : "");
	}

	function installEditor(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new UltraEditor(tui, theme, keybindings);
			editor.setUltra(ultra);
			editor.setFast(fast);
			refreshEditorLabel();
			return editor;
		});
		startAnimation();
	}

	function uninstallEditor(ctx: ExtensionContext): void {
		stopAnimation();
		editor = undefined;
		if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
	}

	/* ---------------------- glass / RGB animation ---------------------- */

	let phase = 0;
	let shine = 0.18;

	function startAnimation(): void {
		if (animTimer !== undefined) return;
		animTimer = setInterval(() => {
			if (!editor || (!ultra && !fast)) return;
			phase = (phase + PHASE_STEP) % 360;
			shine = (shine + SHINE_STEP) % 1;
			editor.tick(phase, shine);
		}, FRAME_MS);
	}

	function stopAnimation(): void {
		if (animTimer !== undefined) {
			clearInterval(animTimer);
			animTimer = undefined;
		}
		editor?.tick(phase, shine); // 정지 상태로 1회 갱신
	}

	/* ------------------------------ footer ----------------------------- */

	function makeFooterProvider(): UltraFooterProvider {
		const getCtx = () => footerCtx!;
		return {
			getEntries: () => getCtx().sessionManager.getEntries(),
			getCwd: () => getCtx().cwd,
			getSessionName: () => getCtx().sessionManager.getSessionName(),
			getModel: () => {
				const m = getCtx().model;
				return m
					? { id: m.id, provider: m.provider, reasoning: !!m.reasoning, contextWindow: m.contextWindow }
					: undefined;
			},
			getThinkingLevel: () => getCtx().thinkingLevel,
			getContextUsage: () => getCtx().getContextUsage(),
			getTps: () => tps,
			isStreaming: () => streaming,
			getModeLabels: () => {
				const parts: string[] = [];
				if (ultra) parts.push("ULTRAMODE");
				if (fast) parts.push("FAST");
				return parts;
			},
			getSubagents: () =>
				[...runningSubagents.values()].flatMap((rows) => rows.map((s) => ({
					...s,
					elapsedMs: s.state === "queued" ? 0 : s.state === "running" ? Date.now() - s.startedAt : s.elapsedMs ?? 0,
				}))),
		};
	}

	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		footerCtx = ctx;
		ctx.ui.setFooter((tui, theme, footerData) => {
			footerRender = () => tui.requestRender();
			footer = new UltraFooter(tui, theme, footerData, makeFooterProvider());
			return footer;
		});
	}

	function uninstallFooter(ctx: ExtensionContext): void {
		footerRender = undefined;
		footerCtx = undefined;
		footer = undefined;
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	}

	/** 서브에이전트 동작 중에는 경과 시간/스피너를 주기적으로 갱신한다. */
	function ensureSubagentTimer(): void {
		if (subagentTimer !== undefined) return;
		subagentTimer = setInterval(() => {
			if (runningSubagents.size === 0) {
				if (subagentTimer !== undefined) {
					clearInterval(subagentTimer);
					subagentTimer = undefined;
				}
				footerRender?.();
				return;
			}
			footer?.tickSpinner();
			footerRender?.();
		}, 150);
	}

	/* ------------------------------ status ----------------------------- */

	function updateStatus(ctx: ExtensionContext): void {
		const parts: string[] = [];
		if (ultra) parts.push("ULTRAMODE");
		if (fast) parts.push("FAST");
		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? ctx.ui.theme.fg("accent", parts.join(" ")) : undefined);
	}

	function persist(): void {
		pi.appendEntry(STATE_TYPE, { enabled: ultra, fast });
	}

	/* --------------------------- ultramode ----------------------------- */

	function enableSubagentTool(): void {
		const active = pi.getActiveTools();
		if (active.includes(TOOL_NAME)) {
			toolsBeforeEnable = undefined;
			return;
		}
		toolsBeforeEnable = active;
		pi.setActiveTools([...new Set([...active, TOOL_NAME])]);
	}

	function restoreTools(): void {
		if (toolsBeforeEnable !== undefined) {
			pi.setActiveTools(toolsBeforeEnable);
			toolsBeforeEnable = undefined;
		}
	}

	function setUltra(next: boolean, ctx: ExtensionContext): void {
		ultra = next;
		if (next) enableSubagentTool();
		else restoreTools();
		editor?.setUltra(next);
		refreshEditorLabel();
		updateStatus(ctx);
		persist();
	}

	pi.registerCommand("ultramode", {
		description: "Toggle ultramode: subagents + RGB glass editor border",
		handler: async (_args, ctx) => setUltra(!ultra, ctx),
	});

	/* ------------------------------ fast ------------------------------- */

	function setFast(next: boolean, ctx: ExtensionContext): void {
		if (next === fast) return;
		fast = next;
		editor?.setFast(next);

		if (next) {
			thinkingBeforeFast = pi.getThinkingLevel();
			pi.setThinkingLevel(FAST_THINKING_LEVEL);
		} else if (thinkingBeforeFast !== undefined) {
			pi.setThinkingLevel(thinkingBeforeFast);
			thinkingBeforeFast = undefined;
		}

		refreshEditorLabel();
		updateStatus(ctx);
		persist();
	}

	pi.registerCommand("fast", {
		description: `Toggle fast mode (thinking=${FAST_THINKING_LEVEL}, service_tier=${FAST_SERVICE_TIER})`,
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") setFast(true, ctx);
			else if (arg === "off") setFast(false, ctx);
			else setFast(!fast, ctx);
		},
	});

	// fast 모드일 때 service_tier 를 요청 본문에 주입한다.
	pi.on("before_provider_request", (event) => {
		if (!fast) return;
		const payload = event.payload;
		if (!payload || typeof payload !== "object") return;
		const body = payload as Record<string, unknown>;
		if (body.service_tier !== undefined) return;
		return { ...body, service_tier: FAST_SERVICE_TIER };
	});

	// 추론 강도가 바뀌면 라벨/상태 갱신
	pi.on("thinking_level_select", async () => {
		refreshEditorLabel();
	});

	/* --------------------------- subagent tracking ---------------------- */

	// 서브에이전트 도구 실행 시작/종료를 추적해 푸터에 표시한다.
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== TOOL_NAME) return;
		const args = (event.args ?? {}) as {
			agent?: string;
			task?: string;
			tasks?: Array<{ agent: string; task?: string }>;
			chain?: Array<{ agent: string; task?: string }>;
		};
		const tasks = args.tasks?.length ? args.tasks : args.chain?.length ? args.chain : [{ agent: args.agent ?? "subagent", task: args.task }];
		runningSubagents.set(event.toolCallId, tasks.map((task, index) => ({
			agent: task.agent,
			task: task.task ?? "",
			index,
			state: "queued",
			displayTokens: unknownTokens(),
			startedAt: Date.now(),
		})));
		ensureSubagentTimer();
		footerRender?.();
	});

	pi.on("tool_execution_update", async (event) => {
		if (event.toolName !== TOOL_NAME) return;
		const rows = runningSubagents.get(event.toolCallId);
		if (!rows) return;
		const results = (event.partialResult as { details?: { results?: any[] } })?.details?.results;
		if (!Array.isArray(results)) return;
		for (let position = 0; position < results.length; position++) {
			const result = results[position];
			const index = result.index ?? (result.step ? result.step - 1 : position);
			const row = rows[index];
			if (!row) continue;
			const state = resultState(result);
			if (row.state === "queued" && state !== "queued") row.startedAt = Date.now() - (result.elapsedMs ?? 0);
			row.state = state;
			row.displayTokens = resultTokens(result);
			row.elapsedMs = result.elapsedMs;
		}
		footerRender?.();
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME) return;
		runningSubagents.delete(event.toolCallId);
		footerRender?.();
	});

	/* ------------------------------ events ----------------------------- */

	// ULTRAMODE 활성 시 서브에이전트 사용을 강하게 유도한다.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!ultra) return;

		const discovery = discoverAgents(ctx.cwd, "user");
		const names = discovery.agents.map((a) => a.name).join(", ") || "none";

		return {
			message: {
				customType: CONTEXT_TYPE,
				display: false,
				content: `[ULTRAMODE ACTIVE]
You are in ULTRAMODE. Actively delegate work to subagents using the \`${TOOL_NAME}\` tool.

Available subagents: ${names}

Rules:
- Delegate codebase exploration/recon to \`scout\`.
- Delegate implementation and file edits to \`worker\`.
- Delegate implementation planning to \`planner\`.
- Delegate code review / security checks to \`reviewer\`.
- Run independent tasks in PARALLEL (tasks array) and multi-step work as a CHAIN (chain array with {previous}).
- Prefer delegating to a subagent whenever it would reduce the main context or parallelize work.
- Keep only synthesis, final decisions, and the user-facing answer in the main thread.`,
			},
		};
	});

	// 모드가 꺼지면 남아있는 ULTRAMODE 컨텍스트를 제거한다.
	pi.on("context", async (event) => {
		if (ultra) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string };
				return msg.customType !== CONTEXT_TYPE;
			}),
		};
	});

	/* --------------------------- TPS events ---------------------------- */

	let tps: number | null = null;
	let streaming = false;
	let streamedChars = 0;
	let usageOutput = 0;
	let calibration = 0.25;
	let samples: Array<{ t: number; tokens: number }> = [];
	let tpsTimer: ReturnType<typeof setInterval> | undefined;

	function estimatedTokens(): number {
		return Math.max(usageOutput, streamedChars * calibration);
	}

	function updateTps(): void {
		const now = Date.now();
		samples.push({ t: now, tokens: estimatedTokens() });
		while (samples.length > 0 && now - samples[0]!.t > TPS_WINDOW_MS) samples.shift();
		if (samples.length >= 2) {
			const first = samples[0]!;
			const last = samples[samples.length - 1]!;
			const dt = (last.t - first.t) / 1000;
			const dtok = last.tokens - first.tokens;
			if (dt >= 0.35 && dtok >= 0) tps = dtok / dt;
		}
	}

	function beginStream(): void {
		streaming = true;
		streamedChars = 0;
		usageOutput = 0;
		samples = [];
		tps = null;
		if (tpsTimer === undefined) {
			tpsTimer = setInterval(() => {
				if (!streaming) return;
				updateTps();
				footerRender?.();
			}, TPS_REDRAW_MS);
		}
	}

	function endStream(): void {
		streaming = false;
		if (tpsTimer !== undefined) {
			clearInterval(tpsTimer);
			tpsTimer = undefined;
		}
		footerRender?.();
	}

	pi.on("agent_start", async () => beginStream());

	pi.on("message_update", async (event) => {
		const ev = event.assistantMessageEvent;
		if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
			streamedChars += ev.delta.length;
		}
		const out = (event.message as AssistantMessage)?.usage?.output ?? 0;
		if (out > usageOutput) usageOutput = out;
		if (!streaming) beginStream();
		updateTps();
		footerRender?.();
	});

	pi.on("message_end", async (event) => {
		const msg = event.message as AssistantMessage;
		if (msg?.role !== "assistant") return;
		const out = msg.usage?.output ?? 0;
		if (out > 0 && streamedChars > 0) calibration = out / streamedChars;
		if (out > 0) usageOutput = out;
		endStream();
	});

	pi.on("agent_settled", async () => endStream());

	/* --------------------------- session events ------------------------ */

	pi.on("session_start", async (_event, ctx) => {
		runningSubagents.clear();
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === STATE_TYPE)
			.pop() as { data?: { enabled?: boolean; fast?: boolean } } | undefined;

		ultra = last?.data?.enabled ?? false;
		fast = last?.data?.fast ?? false;
		if (ultra) enableSubagentTool();

		// 에디터(글래스 박스)와 푸터는 항상 설치한다.
		installEditor(ctx);
		installFooter(ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runningSubagents.clear();
		stopAnimation();
		endStream();
		if (subagentTimer !== undefined) {
			clearInterval(subagentTimer);
			subagentTimer = undefined;
		}
		uninstallEditor(ctx);
		uninstallFooter(ctx);
	});
}
