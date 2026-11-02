export interface DisplayTokens {
	input: number | null;
	output: number | null;
	estimatedInput: boolean;
	estimatedOutput: boolean;
}

export type SubagentState = "queued" | "running" | "completed" | "failed";

export function unknownTokens(): DisplayTokens {
	return { input: null, output: null, estimatedInput: false, estimatedOutput: false };
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function contentChars(message: any): number {
	return (message?.content ?? []).reduce((total: number, part: any) => {
		if (part.type === "text") return total + (part.text?.length ?? 0);
		if (part.type === "thinking") return total + (part.thinking?.length ?? 0);
		if (part.type === "toolCall") return total + (part.name?.length ?? 0) + JSON.stringify(part.arguments ?? {}).length;
		return total;
	}, 0);
}

function add(a: DisplayTokens, b: DisplayTokens): DisplayTokens {
	return {
		input: a.input === null || b.input === null ? null : a.input + b.input,
		output: a.output === null || b.output === null ? null : a.output + b.output,
		estimatedInput: a.estimatedInput || b.estimatedInput,
		estimatedOutput: a.estimatedOutput || b.estimatedOutput,
	};
}

export class LiveSubagentUsage {
	private completed: DisplayTokens = { input: 0, output: 0, estimatedInput: false, estimatedOutput: false };
	private active: DisplayTokens | undefined;
	private streamedChars = 0;
	private message: any;
	private ended = false;

	update(event: any): DisplayTokens {
		if (event.type === "message_start" && event.message?.role === "assistant") {
			this.active = unknownTokens();
			this.streamedChars = 0;
			this.message = undefined;
			this.ended = false;
		}
		const final = event.type === "message_end" && event.message?.role === "assistant";
		if (event.type === "message_update" || final || (event.type === "message_start" && event.message?.role === "assistant")) {
			if (final && this.ended) return this.snapshot();
			const update = event.assistantMessageEvent;
			if (update && ["text_delta", "thinking_delta", "toolcall_delta"].includes(update.type)) {
				this.streamedChars += typeof update.delta === "string" ? update.delta.length : 0;
			}
			const message = event.message ?? update?.partial ?? this.message;
			this.message = message;
			const usage = event.usage ?? message?.usage;
			const input = count(usage?.input) + count(usage?.cacheRead) + count(usage?.cacheWrite);
			const reported = count(usage?.output);
			const estimate = Math.ceil(Math.max(this.streamedChars, contentChars(message)) / 4);
			const validFinal = final && input + reported > 0;
			const validOutput = validFinal && (reported > 0 || estimate === 0);
			this.active = {
				input: input > 0 || validFinal ? input : this.active?.input ?? null,
				output: validOutput ? reported : Math.max(reported, estimate) || null,
				estimatedInput: false,
				estimatedOutput: !validOutput && estimate > reported,
			};
			if (final) {
				this.completed = add(this.completed, this.active);
				this.active = undefined;
				this.ended = true;
			}
		}
		return this.snapshot();
	}

	snapshot(): DisplayTokens {
		if (this.active) return add(this.completed, this.active);
		return this.ended ? { ...this.completed } : unknownTokens();
	}
}

export function resultTokens(result: any): DisplayTokens {
	if (result.displayTokens) return result.displayTokens;
	const usage = result.usage;
	if (!usage || !(usage.turns || usage.input || usage.output || usage.cacheRead || usage.cacheWrite)) return unknownTokens();
	return { input: count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite), output: count(usage.output), estimatedInput: false, estimatedOutput: false };
}

export function resultState(result: any): SubagentState {
	if (result.state) return result.state;
	if (result.exitCode === -1) return "running";
	return result.exitCode !== 0 || ["error", "aborted"].includes(result.stopReason) ? "failed" : "completed";
}

export function formatDisplayTokens(tokens: DisplayTokens): string {
	const format = (value: number | null, estimated: boolean) => {
		if (value === null) return "?";
		const text = value < 1000 ? String(value) : value < 1000000 ? `${(value / 1000).toFixed(1)}k` : `${(value / 1000000).toFixed(1)}M`;
		return `${estimated ? "~" : ""}${text}`;
	};
	return `IN ${format(tokens.input, tokens.estimatedInput)} OUT ${format(tokens.output, tokens.estimatedOutput)}`;
}
