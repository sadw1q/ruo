/**
 * UltraEditor
 *
 * 입력창을 네모 박스로 감싸고 테두리에 **글래스(glassmorphism) 효과**를 입힌다.
 *
 * - 기본 테두리 색: 추론 강도(thinking level)에 따라 pi가 지정하는 색을 그대로 사용
 * - ULTRAMODE 활성 시: 테두리 색이 RGB 무지개로 흐름
 * - 글래스 효과 (모든 색에 공통):
 *     1. 세로 광택 그라데이션 (상단 밝음 → 하단 어두움)
 *     2. 테두리를 따라 흐르는 스페큘러(하이라이트) 반사
 *     3. 유리에 비친 듯한 옅은 서리(frost) 틴트
 */

import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { clamp255, fg, hsvToRgb, parseAnsiColor } from "./rgb.ts";

/* ------------------------------- Editor ------------------------------ */

export class UltraEditor extends CustomEditor {
	private ultraActive = false;
	private fastActive = false;
	private glassOn = true;
	private label = "";

	private phase = 0; // RGB 무지개 위상
	private shine = 0.18; // 글래스 하이라이트 위치 (0..1)

	/** borderColor에서 읽어둔 기본 RGB (테마/추론강도 색). */
	private cachedRgb: [number, number, number] = [150, 180, 210];

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
	}

	/* -------------------------- public API -------------------------- */

	setUltra(active: boolean): void {
		this.ultraActive = active;
		this.invalidate();
		this.tui.requestRender();
	}

	setFast(active: boolean): void {
		this.fastActive = active;
		this.invalidate();
		this.tui.requestRender();
	}

	renderAnimatedBorder(line: string, reverse = false): string {
		if (!this.fastActive && !this.ultraActive) return line;
		const cells = Array.from(stripTerminalSequences(line));
		return cells.map((cell, index) => {
			const position = (reverse ? cells.length - 1 - index : index) / Math.max(1, cells.length);
			return fg(cell, ...hsvToRgb(this.phase + position * 360, 0.85, 1));
		}).join("");
	}

	/** 글래스 효과 on/off. */
	setGlass(on: boolean): void {
		this.glassOn = on;
		this.invalidate();
		this.tui.requestRender();
	}

	/** 상단 테두리 가운데 라벨. */
	setLabel(label: string): void {
		if (this.label === label) return;
		this.label = label;
		this.invalidate();
		this.tui.requestRender();
	}

	/** 애니메이션 프레임 갱신. */
	tick(phase: number, shine: number): void {
		this.phase = phase;
		this.shine = shine;
		this.invalidate();
		this.tui.requestRender();
	}

	/* --------------------------- glass --------------------------- */

	/** 현재 시점의 기본 색 (u: 테두리 둘레 위치 0..1). */
	private baseColor(u: number): [number, number, number] {
		if (this.ultraActive || this.fastActive) {
			const hue = ((u * 720 + this.phase) % 360 + 360) % 360;
			return hsvToRgb(hue, 1, 1);
		}
		// 추론 강도 색: 글래스 반사를 위해 아주 약하게 위치 변조.
		const [r, g, b] = this.cachedRgb;
		const mod = 0.94 + 0.06 * Math.sin(u * Math.PI * 2);
		return [r * mod, g * mod, b * mod];
	}

	/**
	 * 글래스 효과를 적용한 한 셀.
	 * u     - 둘레 위치 0..1
	 * depth - 0(상단, 밝음) ~ 1(하단, 어두움)
	 */
	private glassCell(u: number, depth: number, ch: string): string {
		let [r, g, b] = this.baseColor(u);

		if (this.glassOn) {
			// 3) 서리 틴트: 살짝 차갑고 밝은 톤을 섞는다.
			r = r * 0.88 + 210 * 0.12;
			g = g * 0.88 + 226 * 0.12;
			b = b * 0.88 + 248 * 0.12;

			// 1) 세로 광택 그라데이션.
			const gloss = 0.78 + 0.36 * (1 - depth);
			r *= gloss;
			g *= gloss;
			b *= gloss;

			// 2) 흐르는 스페큘러 하이라이트.
			const d = Math.abs(u - this.shine);
			const dist = Math.min(d, 1 - d); // 원형 거리
			const spec = Math.max(0, 1 - dist * 5.5);
			const add = spec * spec * 120;
			r += add;
			g += add;
			b += add;
		}

		return fg(ch, clamp255(r), clamp255(g), clamp255(b));
	}

	/* --------------------------- render --------------------------- */

	override render(width: number): string[] {
		// 추론 강도/테마가 바뀌면 borderColor가 갱신되므로 매 렌더마다 색을 다시 읽는다.
		try {
			const parsed = parseAnsiColor(this.borderColor("x"));
			if (parsed) this.cachedRgb = parsed;
		} catch {
			/* borderColor 실패 시 이전 색 유지 */
		}

		if (width < 10) return super.render(width);

		try {
			return this.renderGlassBox(width);
		} catch {
			// 안전 장치: 문제가 생기면 기본 에디터 렌더로 복귀
			return super.render(width);
		}
	}

	private renderGlassBox(width: number): string[] {
		const innerWidth = width - 2;
		const lines = super.render(innerWidth);
		if (lines.length < 2) return lines;

		// 본문 라인 수 파악 (상단 테두리 + 본문 + 하단 테두리 + 자동완성)
		const visibleCount =
			(this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount ?? 0;
		const bottomIndex = Math.min(lines.length - 1, 1 + visibleCount);

		const body = lines.slice(1, bottomIndex);
		if (body.length === 0) body.push(" ".repeat(innerWidth));
		const trailing = lines.slice(bottomIndex + 1).map((l) => ` ${l}`);

		const topLen = width;
		const sideLen = body.length;
		const bottomLen = width;
		const perimeter = Math.max(1, topLen + sideLen + bottomLen + sideLen);
		const toU = (pos: number) => (pos % perimeter) / perimeter;

		const out: string[] = [];

		// 상단 테두리 (+ 가운데 라벨)
		const top: string[] = new Array(width).fill("─");
		top[0] = "╭";
		top[width - 1] = "╮";
		if (this.label && width >= this.label.length + 4) {
			const start = Math.floor((width - this.label.length) / 2);
			for (let i = 0; i < this.label.length; i++) top[start + i] = this.label[i];
		}
		out.push(top.map((ch, x) => this.glassCell(toU(x), 0, ch)).join(""));

		// 본문 + 좌우 테두리
		for (let y = 0; y < sideLen; y++) {
			const row = body[y];
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(row)));
			const depth = sideLen > 1 ? y / (sideLen - 1) : 0.5;
			const left = this.glassCell(toU(topLen + y), depth, "│");
			const right = this.glassCell(toU(topLen + sideLen + bottomLen + (sideLen - 1 - y)), depth, "│");
			out.push(left + row + pad + right);
		}

		// 하단 테두리
		const bottom: string[] = new Array(width).fill("─");
		bottom[0] = "╰";
		bottom[width - 1] = "╯";
		out.push(bottom.map((ch, x) => this.glassCell(toU(topLen + sideLen + x), 1, ch)).join(""));

		for (const t of trailing) out.push(t);
		return out;
	}
}
