/**
 * Risk review for elevated (`run_sudo`) commands.
 *
 * Every `run_sudo` call is first classified by the `Ruo-1.0-review` route on the
 * LMH hub. Upstream it resolves to typesafe/jev, which is a *decisions* model:
 * it does not speak chat/completions, only the structured decisions endpoint
 * (`POST {baseUrl}/decisions` with `{ model, state, questions }`). The hub
 * proxies that shape through unchanged.
 *
 * Scores at or above SUDO_MANUAL_APPROVAL_THRESHOLD require the USER to approve
 * a command summary in the TUI; anything below runs without an extra prompt.
 * Fail-closed: when the review cannot be completed, the command is treated as
 * maximally risky and needs manual approval.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRuoTarget, RUO_REVIEW_MODEL } from "./ruo-lmh.ts";

/** Risk percentage (0-100) at or above which manual USER approval is required. */
export const SUDO_MANUAL_APPROVAL_THRESHOLD = Number(process.env.RUO_SUDO_REVIEW_THRESHOLD ?? process.env.PI_RUO_SUDO_REVIEW_THRESHOLD ?? 50);

export interface SudoRiskAssessment {
	/** 0-100, 100 = maximally dangerous. */
	risk: number;
	/** One of: readonly | package | config | destructive | unknown. */
	category: string;
	/** Model confidence in the category pick, when provided. */
	confidence: number | null;
	/** True when the review could not be completed (fail-closed). */
	reviewFailed: boolean;
	/** Why the review failed, shown in the manual-approval dialog. */
	failureReason?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
	readonly: "읽기 전용",
	package: "패키지 설치/변경",
	config: "시스템 설정/서비스 변경",
	destructive: "데이터 삭제/서비스 중단",
	unknown: "분류 없음",
};

export function sudoCategoryLabel(category: string): string {
	return CATEGORY_LABELS[category] ?? CATEGORY_LABELS.unknown ?? "분류 없음";
}

interface DecisionsResponse {
	answers?: {
		danger?: { type?: string; noul?: unknown };
		category?: { type?: string; choice?: unknown; confidence?: unknown };
	};
	error?: { message?: string } | string;
}

/**
 * Classify a sudo -S -p  command through the hub's decisions proxy.
 *
 * `danger` is a noul question (a calibrated 0-1 scalar); multiplied by 100 it is
 * the risk percentage. `category` is a choice question used for the summary line
 * in the manual-approval dialog.
 */
export async function assessSudoRisk(
	command: string,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<SudoRiskAssessment> {
	const fallback = (reason: string): SudoRiskAssessment => ({
		risk: 100,
		category: "unknown",
		confidence: null,
		reviewFailed: true,
		failureReason: reason,
	});

	try {
		const target = await resolveRuoTarget(ctx);
		const timeoutMs = Number(process.env.RUO_REVIEW_TIMEOUT_MS ?? process.env.PI_RUO_REVIEW_TIMEOUT_MS ?? 60_000);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const forwardAbort = () => controller.abort();
		signal?.addEventListener("abort", forwardAbort, { once: true });
		try {
			const response = await fetch(`${target.baseUrl}/decisions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${target.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: RUO_REVIEW_MODEL,
					state: command,
					threshold: SUDO_MANUAL_APPROVAL_THRESHOLD,
					questions: {
						danger: {
							type: "noul",
							instructions:
								"How dangerous is running this exact command with root privileges, on a 0-1 scale where 0 is completely safe read-only inspection and 1 is catastrophic irreversible damage (mass data loss, bricked system, security exposure)? Consider destructiveness, scope, and reversibility.",
						},
						category: {
							type: "choice",
							instructions: "Pick the category that best describes what this command does.",
							criteria: {
								readonly: "Only reads or displays system state; nothing is modified",
								package: "Installs, updates, or removes software packages",
								config: "Modifies system configuration, services, users, or permissions",
								destructive: "Deletes data, wipes devices, or disrupts running services",
							},
						},
					},
				}),
				signal: controller.signal,
			});
			const body = await response.text();
			if (!response.ok) {
				return fallback(`리뷰 모델 요청 실패 (HTTP ${response.status}): ${body.slice(0, 200)}`);
			}
			let parsed: DecisionsResponse;
			try {
				parsed = JSON.parse(body) as DecisionsResponse;
			} catch {
				return fallback("리뷰 모델 응답을 해석할 수 없습니다.");
			}
			const noul = parsed.answers?.danger?.noul;
			const riskValue = typeof noul === "number" ? noul : Number.parseFloat(String(noul ?? ""));
			if (!Number.isFinite(riskValue)) return fallback("리뷰 모델이 위험도 점수를 반환하지 않았습니다.");
			const choice = parsed.answers?.category?.choice;
			const confidence = parsed.answers?.category?.confidence;
			return {
				risk: Math.max(0, Math.min(100, Math.round(riskValue * 100))),
				category: typeof choice === "string" && choice in CATEGORY_LABELS ? choice : "unknown",
				confidence: typeof confidence === "number" ? confidence : null,
				reviewFailed: false,
			};
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", forwardAbort);
		}
	} catch (error) {
		return fallback(error instanceof Error ? error.message : String(error));
	}
}
