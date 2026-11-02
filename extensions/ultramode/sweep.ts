/**
 * SweepBar
 *
 * fast 모드가 켜질 때 작업 표시줄(working) 근처를 반짝 훑고 지나가는
 * 가로 스윕 애니메이션 컴포넌트. 1.2초 동안 왼쪽→오른쪽으로 빛이 지나간다.
 */

import type { Component } from "@earendil-works/pi-tui";
import { clamp255, fg, hsvToRgb } from "./rgb.ts";

export class SweepBar implements Component {
	/** 0..1 진행도 */
	private progress = 0;

	setProgress(p: number): void {
		this.progress = p;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [""];

		// 밴드 중심은 화면 좌우 바깥에서 시작/종료한다.
		const center = this.progress * (width + 16) - 8;
		const baseR = 52;
		const baseG = 56;
		const baseB = 68;

		let out = "";
		for (let x = 0; x < width; x++) {
			const d = Math.abs(x - center);
			const glow = Math.max(0, 1 - d / 7);
			const g = glow * glow;

			// 밴드 색: 위치 기반 무지개 + 진행 위상
			const hue = ((x / width) * 360 + this.progress * 540) % 360;
			const [hr, hg, hb] = hsvToRgb(hue, 1, 1);

			let r = baseR * (1 - g) + hr * g;
			let gg = baseG * (1 - g) + hg * g;
			let b = baseB * (1 - g) + hb * g;

			// 중심부 화이트 핫 코어 (반짝임)
			const core = Math.max(0, 1 - d / 2.5);
			const add = core * core * 170;
			r += add;
			gg += add;
			b += add;

			out += fg("─", clamp255(r), clamp255(gg), clamp255(b));
		}
		return [out];
	}
}
