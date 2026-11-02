import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

/** Convert the non-standard '''lang / ''' fence emitted by some models to Markdown fences. */
function normalizeApostropheFences(markdown: string): string {
	const lines = markdown.split("\n");
	let openLength: number | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const match = line.match(/^( {0,3})('{3,})(.*)$/);
		if (!match) continue;

		const indent = match[1] ?? "";
		const fence = match[2] ?? "";
		const suffix = match[3] ?? "";
		const trimmedSuffix = suffix.trim();

		if (openLength === undefined) {
			// A language suffix such as "bash" is unambiguous. For a bare '''
			// opening, require a matching closing fence to avoid changing prose.
			const hasClosing = lines.slice(i + 1).some((candidate) => {
				const closing = candidate.match(/^ {0,3}('{3,})\s*$/);
				return closing !== null && (closing[1]?.length ?? 0) >= fence.length;
			});
			if (!trimmedSuffix && !hasClosing) continue;
			if (trimmedSuffix.startsWith("'") || trimmedSuffix.includes("```")) continue;

			openLength = fence.length;
			lines[i] = `${indent}${"`".repeat(openLength)}${suffix}`;
			continue;
		}

		if (!trimmedSuffix) {
			lines[i] = `${indent}${"`".repeat(Math.max(openLength, fence.length))}`;
			openLength = undefined;
		}
	}

	return lines.join("\n");
}

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function hideRenderedFenceMarkers(): void {
	const markdownPrototype = Markdown.prototype as Markdown.prototype & {
		__piFenceMarkersHidden?: boolean;
	};
	if (markdownPrototype.__piFenceMarkersHidden) return;
	markdownPrototype.__piFenceMarkersHidden = true;

	const originalRender = Markdown.prototype.render;
	Markdown.prototype.render = function patchedRender(width: number): string[] {
		return originalRender.call(this, width).filter((line) => {
			const plain = line.replace(ANSI_ESCAPE, "").trim();
			return !/^```(?:[^`]*)$/.test(plain);
		});
	};
}

export default function markdownFencesExtension(pi: ExtensionAPI): void {
	// Pi's built-in Markdown component intentionally prints fenced-code delimiters.
	// Hide only those delimiter lines so the transcript shows the code body itself.
	hideRenderedFenceMarkers();
	pi.registerMarkdownTransformer((markdown) => normalizeApostropheFences(markdown));
}
