/**
 * LMH client for the Ruo tool set.
 *
 * `Ruo-1.0` (web search, fast-apply, and reranking) only exists on the local LMH
 * hub, so requests are addressed by provider name rather than through the model
 * registry catalogue. The base URL and API key are resolved from Ruo's provider
 * configuration; nothing is hardcoded here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RUO_PROVIDER = (process.env.RUO_PROVIDER ?? process.env.PI_RUO_PROVIDER)?.trim() || "LMH";

export const RUO_WEB_MODEL = (process.env.RUO_WEB_MODEL ?? process.env.PI_RUO_WEB_MODEL)?.trim() || "Ruo-1.0";
export const RUO_APPLY_MODEL = (process.env.RUO_APPLY_MODEL ?? process.env.PI_RUO_APPLY_MODEL)?.trim() || "Ruo-1.0";
export const RUO_STRONG_MODEL = (process.env.RUO_STRONG_MODEL ?? process.env.PI_RUO_STRONG_MODEL)?.trim() || "Ruo-1.0";
export const RUO_RERANK_MODEL = (process.env.RUO_RERANK_MODEL ?? process.env.PI_RUO_RERANK_MODEL)?.trim() || "Ruo-1.0";
export const RUO_TITLE_MODEL = (process.env.RUO_TITLE_MODEL ?? process.env.PI_RUO_TITLE_MODEL)?.trim() || "Ruo-1.0";
export const RUO_REVIEW_MODEL = (process.env.RUO_REVIEW_MODEL ?? process.env.PI_RUO_REVIEW_MODEL)?.trim() || "Ruo-1.0-review";

const REQUEST_TIMEOUT_MS = Number(process.env.RUO_TIMEOUT_MS ?? process.env.PI_RUO_TIMEOUT_MS ?? 120_000);

export interface RuoTarget {
	provider: string;
	baseUrl: string;
	apiKey: string;
}

let cachedTarget: RuoTarget | undefined;

/** Test hook: forget the resolved provider target. */
export function resetRuoTarget(): void {
	cachedTarget = undefined;
}

export async function resolveRuoTarget(ctx: ExtensionContext): Promise<RuoTarget> {
	if (cachedTarget) return cachedTarget;

	const provider = RUO_PROVIDER;
	let baseUrl = ctx.modelRegistry.getProvider(provider)?.baseUrl?.trim();
	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
	} catch {
		apiKey = undefined;
	}

	// Fall back to models.json so a provider that is not surfaced through the
	// registry (or an offline hub) still resolves.
	if (!baseUrl || !apiKey) {
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "models.json"), "utf8")) as {
				providers?: Record<string, { baseUrl?: unknown; apiKey?: unknown }>;
			};
			const config = parsed?.providers?.[provider];
			if (!baseUrl && typeof config?.baseUrl === "string") baseUrl = config.baseUrl.trim();
			if (!apiKey && typeof config?.apiKey === "string") apiKey = config.apiKey;
		} catch {
			// Reported below.
		}
	}

	if (!baseUrl) {
		throw new Error(`Ruo: no base URL configured for provider "${provider}" (set RUO_PROVIDER or models.json).`);
	}
	if (!apiKey) {
		throw new Error(`Ruo: no API key configured for provider "${provider}" (set RUO_PROVIDER or models.json).`);
	}

	cachedTarget = { provider, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
	return cachedTarget;
}

export interface RuoChatOptions {
	model: string;
	user: string;
	system?: string;
	maxTokens?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

/** Single-shot chat completion against the LMH hub. */
export async function ruoChat(target: RuoTarget, options: RuoChatOptions): Promise<string> {
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const forwardAbort = () => controller.abort();
	options.signal?.addEventListener("abort", forwardAbort, { once: true });

	try {
		const messages: Array<{ role: string; content: string }> = [];
		if (options.system) messages.push({ role: "system", content: options.system });
		messages.push({ role: "user", content: options.user });

		const response = await fetch(`${target.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${target.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: options.model,
				messages,
				max_tokens: options.maxTokens ?? 2048,
				stream: false,
			}),
			signal: controller.signal,
		});

		const body = await response.text();
		if (!response.ok) {
			throw new Error(`Ruo model "${options.model}" failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error(`Ruo model "${options.model}" returned a non-JSON response: ${body.slice(0, 200)}`);
		}

		const text = contentToText(
			(parsed as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content,
		).trim();
		if (!text) throw new Error(`Ruo model "${options.model}" returned an empty response.`);
		return text;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", forwardAbort);
	}
}

/** Parse a JSON object out of a model response, tolerating code fences and prose. */
export function extractJson<T>(text: string): T | undefined {
	const cleaned = text
		.replace(/^\s*```(?:json)?/i, "")
		.replace(/```\s*$/, "")
		.trim();

	const candidates = [cleaned];
	const first = cleaned.indexOf("{");
	const last = cleaned.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate) as T;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}
