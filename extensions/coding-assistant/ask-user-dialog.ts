/**
 * AskUserDialog
 *
 * ask_user 도구가 사용하는 선택 대화상자.
 *
 * - 질문은 Markdown으로 렌더링한다 (선택 목록의 제목처럼 그대로 노출되지 않는다).
 * - 선택지와 직접 입력을 한 목록에서 ↑↓/Enter 로 고른다. 숫자키로도 선택 가능.
 * - 구분선은 폭 전체를 채우는 하나의 이어진 직선(─)이고, 각 선택지 다음에 들어가
 *   행들이 세로로 이어져 보인다. "--" 같은 점선이 아니다.
 * - 직접 입력 중에는 매 입력마다 캐시를 비워 화면에 즉시 반영한다.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type EditorTheme,
	type MarkdownTheme,
	type TUI,
	Editor,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export const CUSTOM_OPTION_LABEL = "직접 입력";

/** 이어진 일직선 구분선 문자. */
const DIVIDER_CHAR = "─";

export interface AskUserOption {
	label: string;
	description?: string;
}

export interface AskUserDialogResult {
	answer: string;
	wasCustom: boolean;
}

export interface AskUserDialogOptions {
	tui: TUI;
	theme: Theme;
	markdownTheme: MarkdownTheme;
	question: string;
	options: AskUserOption[];
	recommendedIndex?: number;
	done(result: AskUserDialogResult | null): void;
}

interface Row {
	kind: "option" | "custom";
	index: number;
	label: string;
	description?: string;
	recommended: boolean;
}

export class AskUserDialog {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly rows: Row[];
	private readonly markdown: Markdown;
	private readonly editor: Editor;
	private readonly done: (result: AskUserDialogResult | null) => void;

	private selected = 0;
	private editing = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Focusable: 자식 Editor 로 포커스를 전달해 IME 커서 위치가 맞도록 한다.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(options: AskUserDialogOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.done = options.done;

		this.rows = [
			...options.options.map((option, index) => ({
				kind: "option" as const,
				index,
				label: option.label,
				description: option.description,
				recommended: index === options.recommendedIndex,
			})),
			{ kind: "custom" as const, index: options.options.length, label: CUSTOM_OPTION_LABEL, recommended: false },
		];

		// 권장 선택지를 기본 커서 위치로 둔다.
		const recommendedRow = this.rows.findIndex((row) => row.recommended);
		this.selected = recommendedRow >= 0 ? recommendedRow : 0;

		this.markdown = new Markdown(options.question, 0, 0, options.markdownTheme);

		const editorTheme: EditorTheme = {
			borderColor: (text) => this.theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		};
		this.editor = new Editor(this.tui, editorTheme);
		this.editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				this.done({ answer: trimmed, wasCustom: true });
				return;
			}
			this.editing = false;
			this.editor.setText("");
			this.invalidate();
			this.tui.requestRender();
		};
	}

	dispose(): void {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.markdown.invalidate();
		this.editor.invalidate();
	}

	handleInput(data: string): void {
		if (this.editing) {
			if (matchesKey(data, Key.escape)) {
				this.editing = false;
				this.editor.setText("");
				this.editor.focused = this._focused;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.editor.handleInput(data);
			// 편집 중에는 반드시 캐시를 비운다. 그렇지 않으면 입력이 화면에 반영되지 않는다.
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selected = Math.min(this.rows.length - 1, this.selected + 1);
		} else if (matchesKey(data, Key.enter)) {
			this.activateRow(this.rows[this.selected]);
			return;
		} else if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		} else if (/^[1-9]$/.test(data)) {
			const target = Number(data) - 1;
			const row = this.rows.find((candidate) => candidate.index === target);
			if (row) {
				this.selected = this.rows.indexOf(row);
				this.activateRow(row);
				return;
			}
		} else {
			return;
		}

		this.invalidate();
		this.tui.requestRender();
	}

	/** 선택지를 확정하거나, 직접 입력 행이면 편집 모드로 들어간다. */
	private activateRow(row: Row | undefined): void {
		if (!row) return;
		if (row.kind === "custom") {
			this.editing = true;
			this.editor.setText("");
			this.editor.focused = this._focused;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.done({ answer: row.label, wasCustom: false });
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const theme = this.theme;
		const contentWidth = Math.max(1, width);
		const lines: string[] = [];

		// 이어진 일직선 구분선. 모든 구분선이 같은 폭이라 세로로 이어져 보인다.
		const divider = (): string => theme.fg("accent", DIVIDER_CHAR.repeat(contentWidth));

		const pushWrapped = (text: string): void => {
			for (const line of wrapTextWithAnsi(text, contentWidth)) lines.push(truncateToWidth(line, contentWidth, ""));
		};

		// 질문 (Markdown) — 위아래를 구분선으로 감싼다.
		lines.push(divider());
		const questionLines = this.markdown.render(contentWidth).map((line) => truncateToWidth(line, contentWidth, ""));
		while (questionLines.length > 0 && questionLines[questionLines.length - 1].trim() === "") questionLines.pop();
		for (const line of questionLines) lines.push(line);
		lines.push(divider());

		// 각 선택지 다음에 구분선을 넣어 행이 이어지도록 한다.
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			const isSelected = i === this.selected;
			const marker = isSelected ? theme.fg("accent", "❯ ") : "  ";
			const rawLabel = `${row.index + 1}. ${row.label}${row.recommended ? " (권장됨)" : ""}`;
			const label = theme.fg(isSelected ? "accent" : "text", rawLabel);
			const labelWithHint =
				row.kind === "custom" && this.editing ? `${label} ${theme.fg("dim", "✎")}` : label;
			lines.push(truncateToWidth(`${marker}${labelWithHint}`, contentWidth, ""));
			if (row.description) {
				pushWrapped(`   ${theme.fg("muted", row.description)}`);
			}

			if (row.kind === "custom" && this.editing) {
				// 편집기를 행 안에 붙인다. 편집기 상하 테두리가 곧 구분선이 된다.
				for (const line of this.editor.render(contentWidth)) lines.push(line);
			} else {
				lines.push(divider());
			}
		}

		const hint = this.editing
			? theme.fg("dim", "  Enter 제출 · Esc 뒤로")
			: theme.fg("dim", "  ↑↓ 이동 · Enter 선택 · Esc 취소");
		lines.push(truncateToWidth(hint, contentWidth, ""));
		lines.push(divider());

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	/** 커서가 있는 행 (테스트/디버그용). */
	getSelectedRow(): Row | undefined {
		return this.rows[this.selected];
	}
}
