import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

export class SudoPasswordDialog {
	private value = "";
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (value: string | null) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;

	constructor(tui: TUI, theme: Theme, done: (value: string | null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	dispose(): void {
		this.value = "";
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.value = "";
			this.done(null);
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const value = this.value;
			this.value = "";
			this.done(value.length > 0 ? value : null);
			return;
		}

		if (matchesKey(data, Key.backspace)) {
			this.value = Array.from(this.value).slice(0, -1).join("");
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// 일반 입력과 붙여넣기를 모두 처리한다. 제어문자는 제외한다.
		const printable = Array.from(data).filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code >= 32 && code !== 127;
		});
		if (printable.length === 0) return;

		this.value += printable.join("");
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const contentWidth = Math.max(1, width);
		const divider = this.theme.fg("accent", "─".repeat(contentWidth));
		const masked = "•".repeat(Array.from(this.value).length);
		const prompt = this.theme.fg("warning", "sudo 비밀번호");
		const hint = this.theme.fg("dim", "입력 내용은 표시되지 않으며 실행 프로세스에만 전달됩니다 · Enter 제출 · Esc 취소");

		this.cachedLines = [
			divider,
			truncateToWidth(prompt, contentWidth, ""),
			truncateToWidth(`  ${masked}`, contentWidth, ""),
			truncateToWidth(hint, contentWidth, ""),
			divider,
		];
		this.cachedWidth = width;
		return this.cachedLines;
	}
}
