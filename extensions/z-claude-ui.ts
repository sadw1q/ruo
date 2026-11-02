import {
	AssistantMessageComponent,
	CustomEditor,
	ToolExecutionComponent,
	UserMessageComponent,
	VERSION,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";

const ORIGINAL_FACTORY = Symbol.for("ruo.claude-ui.original-factory");

type GutterComponent = {
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): unknown;
	setOutputPad?(padding: number): void;
};

type ToolTokenUsage = {
	input: number | null;
	output: number | null;
	estimatedInput: boolean;
	estimatedOutput: boolean;
};

function readToolTokens(message: AssistantMessage, final: boolean, inputEstimate: number | null, streamedChars = 0): ToolTokenUsage {
	const usage = message.usage;
	const input = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
	const output = usage?.output ?? 0;
	const reported = final && (usage?.totalTokens ?? input + output) > 0;
	const outputEstimate = Math.max(estimateTokens(message), Math.ceil(streamedChars / 4));
	return {
		input: input > 0 || reported ? input : inputEstimate,
		output: reported ? output : Math.max(output, outputEstimate),
		estimatedInput: input <= 0 && !reported,
		estimatedOutput: !reported && (output <= 0 || outputEstimate > output),
	};
}

function formatToolTokens(usage: ToolTokenUsage | undefined): string {
	const format = (tokens: number | null | undefined, estimated: boolean | undefined) =>
		tokens === null || tokens === undefined ? "?" : `${estimated ? "~" : ""}${Math.round(tokens).toLocaleString("en-US")}`;
	return `IN ${format(usage?.input, usage?.estimatedInput)} · OUT ${format(usage?.output, usage?.estimatedOutput)}`;
}

function addGutter(lines: string[], marker: string): string[] {
	const first = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
	return lines.map((line, index) => `${index === first ? marker : "  "}${line}`);
}

function patchMessages(ctx: ExtensionContext, toolTokens: Map<string, ToolTokenUsage>): () => void {
	const restore: Array<() => void> = [];
	const toolLayouts = new WeakMap<GutterComponent, { leading: number; height: number; titleRows: number }>();
	for (const [component, marker] of [
		[UserMessageComponent, "❯"],
		[AssistantMessageComponent, "●"],
		[ToolExecutionComponent, "●"],
	] as const) {
		const prototype = component.prototype as unknown as GutterComponent;
		const originalRender = prototype.render;
		const renderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
		const mouseDescriptor = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
		const originalMouse = prototype.handleMouse;

		prototype.render = function (width) {
			if (width < 8) return originalRender.call(this, width);
			if (this.setOutputPad && Reflect.get(this, "outputPad") !== 0) this.setOutputPad(0);
			if (component === ToolExecutionComponent) {
				for (const name of ["contentBox", "contentText"]) {
					const content = Reflect.get(this, name);
					if (content && content.paddingY !== 0) {
						content.paddingY = 0;
						content.invalidate();
					}
				}
			}
			const color = component === UserMessageComponent
				? "accent"
				: component === ToolExecutionComponent
					? Reflect.get(this, "result")?.isError ? "error" : Reflect.get(this, "isPartial") ? "warning" : "success"
					: "text";
			const prefix = ctx.ui.theme.fg(color, marker) + " ";
			if (component !== ToolExecutionComponent) return addGutter(originalRender.call(this, width - 2), prefix);
			const innerWidth = width - 4;
			const lines = originalRender.call(this, innerWidth);
			const isImage = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
			const leading = lines.findIndex((line) => isImage(line) || stripTerminalSequences(line).trim().length > 0);
			if (leading < 0) {
				toolLayouts.delete(this);
				return [];
			}
			const toolName = Reflect.get(this, "toolName") as string;
			const usage = toolTokens.get(Reflect.get(this, "toolCallId"));
			const title = lines[leading];
			const plainTitle = stripTerminalSequences(title).trimEnd();
			const nameIndex = plainTitle.indexOf(toolName);
			const insertion = visibleWidth(plainTitle.slice(0, nameIndex < 0 ? plainTitle.length : nameIndex + toolName.length));
			const titleLines = isImage(title) ? [title] : wrapTextWithAnsi(
				sliceByColumn(title, 0, insertion)
					+ ctx.ui.theme.fg("muted", `  ${formatToolTokens(usage)}`)
					+ sliceByColumn(title, insertion, Math.max(0, visibleWidth(plainTitle) - insertion)),
				innerWidth,
			);
			toolLayouts.set(this, { leading, height: lines.length, titleRows: titleLines.length });
			const background = Reflect.get(this, "isPartial")
				? "toolPendingBg"
				: Reflect.get(this, "result")?.isError ? "toolErrorBg" : "toolSuccessBg";
			const bgAnsi = ctx.ui.theme.getBgAnsi(background);
			const paint = (line: string) => ctx.ui.theme.bg(background, line.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + bgAnsi));
			const border = (line: string) => ctx.ui.theme.fg("dim", line);
			return [
				...lines.slice(0, leading),
				"  " + paint(border("╭" + "─".repeat(innerWidth) + "╮")),
				...[...titleLines, ...lines.slice(leading + 1)].map((line, index) => {
					if (isImage(line)) return "   " + line;
					const content = truncateToWidth(line, innerWidth, "");
					const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
					return (index === 0 ? prefix : "  ") + paint(border("│") + content + padding + border("│"));
				}),
				"  " + paint(border("╰" + "─".repeat(innerWidth) + "╯")),
			];
		};

		if (originalMouse) {
			prototype.handleMouse = function (event) {
				if (component === ToolExecutionComponent && event.width >= 8) {
					const layout = toolLayouts.get(this);
					if (!layout || event.y <= layout.leading || event.y >= layout.height + layout.titleRows || event.x < 3 || event.x >= event.width - 1) return undefined;
					return originalMouse.call(this, {
						...event,
						x: event.x - 3,
						y: event.y <= layout.leading + layout.titleRows ? layout.leading : event.y - layout.titleRows,
						width: event.width - 4,
						height: layout.height,
					});
				}
				return originalMouse.call(this, event.width < 8 ? event : {
					...event,
					x: event.x - 2,
					width: event.width - 2,
				});
			};
		}

		restore.push(() => {
			if (renderDescriptor) Object.defineProperty(prototype, "render", renderDescriptor);
			else Reflect.deleteProperty(prototype, "render");
			if (mouseDescriptor) Object.defineProperty(prototype, "handleMouse", mouseDescriptor);
			else Reflect.deleteProperty(prototype, "handleMouse");
		});
	}
	return () => restore.reverse().forEach((undo) => undo());
}

function installEditor(ctx: ExtensionContext): void {
	const current = ctx.ui.getEditorComponent();
	const original = current && Reflect.has(current, ORIGINAL_FACTORY)
		? Reflect.get(current, ORIGINAL_FACTORY)
		: current;
	const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui, theme, keybindings) => {
		const editor = original ? original(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
		if (!(editor instanceof CustomEditor)) return editor;

		editor.render = function (width) {
			if (width < 8) return CustomEditor.prototype.render.call(this, width);
			const lines = CustomEditor.prototype.render.call(this, width - 2);
			const visibleRows = Reflect.get(this, "renderedVisibleLineCount") ?? 1;
			const bottom = visibleRows + 1;
			return lines.map((line, index) => {
				if (index === 0 || index === bottom) {
					const border = line + this.borderColor("──");
					const renderAnimatedBorder = Reflect.get(this, "renderAnimatedBorder");
					return renderAnimatedBorder ? renderAnimatedBorder.call(this, border, index === bottom) : border;
				}
				return `${index === 1 ? ctx.ui.theme.fg("accent", "❯ ") : "  "}${line}`;
			});
		};
		editor.handleMouse = function (event) {
			return CustomEditor.prototype.handleMouse.call(this, event.width < 8 ? event : {
				...event,
				x: Math.max(0, event.x - 2),
				width: event.width - 2,
			});
		};
		return editor;
	};
	Reflect.set(factory, ORIGINAL_FACTORY, original);
	ctx.ui.setEditorComponent(factory);
}

export default function claudeUi(ruo: ExtensionAPI): void {
	let restoreMessages: (() => void) | undefined;
	const toolTokens = new Map<string, ToolTokenUsage>();
	let inputEstimate: number | null = null;
	let streamingUsage: ToolTokenUsage | undefined;
	let streamedChars = 0;

	const trackUsage = (message: AssistantMessage, final: boolean) => {
		const usage = readToolTokens(message, final, inputEstimate, streamedChars);
		if (streamingUsage) Object.assign(streamingUsage, usage);
		else streamingUsage = usage;
		for (const content of message.content) {
			if (content.type === "toolCall") toolTokens.set(content.id, streamingUsage);
		}
	};

	ruo.on("context", (event, ctx) => {
		inputEstimate = event.messages.reduce((total, message) => total + estimateTokens(message), 0)
			+ Math.ceil(ctx.getSystemPrompt().length / 4);
	});

	ruo.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		streamingUsage = undefined;
		streamedChars = 0;
	});

	ruo.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const delta = event.assistantMessageEvent;
		if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") {
			streamedChars += delta.delta.length;
		}
		trackUsage(event.message, false);
	});

	ruo.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		trackUsage(event.message, true);
		streamingUsage = undefined;
		streamedChars = 0;
	});

	ruo.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		restoreMessages?.();
		toolTokens.clear();
		streamingUsage = undefined;
		streamedChars = 0;
		inputEstimate = ctx.getContextUsage()?.tokens ?? null;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const usage = readToolTokens(entry.message, true, null);
			for (const content of entry.message.content) {
				if (content.type === "toolCall") toolTokens.set(content.id, usage);
			}
		}
		restoreMessages = patchMessages(ctx, toolTokens);
		installEditor(ctx);
		ctx.ui.setWorkingIndicator({
			frames: ["·", "✢", "✳", "✶", "✻", "✽"].map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 120,
		});
		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width) {
				const home = process.env.HOME;
				const cwd = home && (ctx.cwd === home || ctx.cwd.startsWith(home + "/"))
					? "~" + ctx.cwd.slice(home.length)
					: ctx.cwd;
				return [
					`${theme.fg("accent", "✻")} ${theme.bold("Ruo")} ${theme.fg("dim", "v" + VERSION)}`,
					theme.fg("muted", `${ctx.model?.id ?? "모델 선택 필요"} · ${ctx.model?.provider ?? ""}`),
					theme.fg("dim", cwd),
				].map((line) => truncateToWidth(line, width, "…"));
			},
		}));
	});

	ruo.on("session_shutdown", async () => {
		restoreMessages?.();
		restoreMessages = undefined;
		toolTokens.clear();
		streamingUsage = undefined;
		streamedChars = 0;
		inputEstimate = null;
	});
}
