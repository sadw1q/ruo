/**
 * RGB / ANSI color helpers shared by the ULTRAMODE extension.
 */

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	const c = v * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const m = v - c;
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** xterm-256 인덱스를 RGB로 변환. */
export function ansi256ToRgb(n: number): [number, number, number] {
	const base16: Array<[number, number, number]> = [
		[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
		[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
		[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
		[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
	];
	if (n < 16) return base16[n] ?? [255, 255, 255];
	if (n < 232) {
		const c = n - 16;
		const conv = (v: number) => (v === 0 ? 0 : 55 + v * 40);
		return [conv(Math.floor(c / 36)), conv(Math.floor((c % 36) / 6)), conv(c % 6)];
	}
	const gray = 8 + (n - 232) * 10;
	return [gray, gray, gray];
}

/** ANSI 문자열에서 전경색 RGB를 추출한다. 없으면 null. */
export function parseAnsiColor(s: string): [number, number, number] | null {
	const truecolor = s.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const indexed = s.match(/\x1b\[38;5;(\d+)m/);
	if (indexed) return ansi256ToRgb(Number(indexed[1]));
	return null;
}

/** truecolor 전경색 적용. */
export function fg(text: string, r: number, g: number, b: number): string {
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function clamp255(v: number): number {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
