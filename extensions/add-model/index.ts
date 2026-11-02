/**
 * /addmodel — 모델을 프로바이더에 추가하는 명령
 *
 * 사용법
 *   /addmodel {model_id}   모델 ID를 주면 프로바이더를 골라 등록한다
 *   /addmodel              모델 ID를 물어본 뒤 같은 흐름으로 진행한다
 *
 * 동작
 *   1. 프로바이더 후보를 보여준다. 목록은 `~/.ruo/agent/models.json` 의 프로바이더이고,
 *      파일이 비어 있으면 지금 쓸 수 있는(인증된) 프로바이더로 대체한다.
 *      같은 ID를 이미 가진 곳에는 `has` 배지를 단다.
 *   2. 고른 프로바이더의 모델로 `models.json` 에 기록한다.
 *   3. pi의 모델 카탈로그를 다시 읽혀(네트워크 없이) 현재 세션에 즉시 반영한다.
 *      그래서 `/model` 을 열면 바로 목록에 나온다.
 *
 * 모델의 추론 여부·컨텍스트·최대 출력·compat 은 같은 프로바이더의 기존 모델에서
 * 물려받는다. `maxTokens` 를 적지 않아 16k 로 잘리는 일을 막기 위해서다.
 * 물려받을 모델이 없으면 128k/16k 를 쓴다.
 *
 * 파일은 임시 파일에 쓴 뒤 교체하고, 덮어쓰기 전에 `models.json.bak.<시각>` 로
 * 백업한다. 다른 프로바이더의 설정은 건드리지 않는다.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	DynamicBorder,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type SelectItem,
} from "@earendil-works/pi-tui";

/** 물려받을 모델이 없을 때 쓰는 기본값. */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;

/**
 * models.json 의 모델 정의.
 * 넘겨주는 값은 pi가 그대로 쓰므로 타입을 좁히지 않고 unknown 으로 둔다.
 */
interface ModelDefinition {
	id: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: unknown;
	input?: unknown;
	cost?: unknown;
	contextWindow?: number;
	maxTokens?: number;
	samplingParams?: unknown;
	headers?: unknown;
	compat?: unknown;
}

interface ProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: unknown;
	authHeader?: boolean;
	models?: ModelDefinition[];
	[key: string]: unknown;
}

interface ModelsJson {
	providers: Record<string, ProviderConfig>;
	[key: string]: unknown;
}

/** 기존 모델에서 설정을 물려받을 때 보는 최소한의 형태. */
interface ModelBasis {
	id?: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: unknown;
	input?: unknown;
	cost?: unknown;
	contextWindow?: number;
	maxTokens?: number;
	samplingParams?: unknown;
	headers?: unknown;
	compat?: unknown;
}

interface Candidate {
	name: string;
	/** models.json 에 이미 있는 항목. 없으면(빌트인 프로바이더) 새로 만든다. */
	config?: ProviderConfig;
	/** 이 프로바이더에 같은 ID가 이미 있는지. */
	hasModel: boolean;
	/** 설정을 물려받을 기존 모델들. 앞에 있을수록 우선한다. */
	bases: ModelBasis[];
	/** 물려받을 설정을 어디서 가져왔는지. */
	basisSource: string;
}

/* ------------------------------------------------------------------ */
/* 파일 읽기/쓰기                                                      */
/* ------------------------------------------------------------------ */

function getModelsPath(): string {
	return path.join(getAgentDir(), "models.json");
}

/** models.json 은 JSONC 를 허용한다. 다시 쓸 때 주석을 지운다. */
function stripJsonComments(input: string): string {
	let output = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		const next = input[i + 1];

		if (inLine) {
			if (char === "\n") {
				inLine = false;
				output += char;
			}
			continue;
		}
		if (inBlock) {
			if (char === "*" && next === "/") {
				inBlock = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			output += char;
			if (char === "\\") {
				output += next ?? "";
				i += 1;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === "/" && next === "/") {
			inLine = true;
			i += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlock = true;
			i += 1;
			continue;
		}
		output += char;
	}
	return output;
}

function readModelsFile(): ModelsJson {
	const file = getModelsPath();
	if (!fs.existsSync(file)) return { providers: {} };

	const raw = fs.readFileSync(file, "utf-8");
	if (!raw.trim()) return { providers: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch (error) {
		throw new Error(
			`models.json 을 해석할 수 없습니다: ${error instanceof Error ? error.message : String(error)}\n${file}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`models.json 형식이 올바르지 않습니다 (최상위는 객체여야 합니다).\n${file}`);
	}

	const config = parsed as ModelsJson;
	if (config.providers === null || typeof config.providers !== "object" || Array.isArray(config.providers)) {
		config.providers = {};
	}
	return config;
}

/** 덮어쓰기 전에 백업을 남긴다. 복사에 실패하면 원본을 건드리지 않고 중단한다. */
function backupModelsFile(): string | undefined {
	const file = getModelsPath();
	if (!fs.existsSync(file)) return undefined;
	const backup = `${file}.bak.${Date.now()}`;
	fs.copyFileSync(file, backup);
	return backup;
}

/** 임시 파일에 쓴 뒤 교체한다. 쓰다가 실패해도 원본이 깨지지 않는다. */
function writeJsonAtomic(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp.${process.pid}`;
	fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	fs.renameSync(temp, file);
}

/* ------------------------------------------------------------------ */
/* 모델 정의 만들기                                                    */
/* ------------------------------------------------------------------ */

/** 프로바이더 안의 모델을 id 순으로 정렬해 파일을 읽기 좋게 유지한다. */
function sortModelList(providers: Record<string, ProviderConfig>): void {
	for (const config of Object.values(providers)) {
		if (Array.isArray(config.models)) {
			config.models.sort((a, b) => String(a.id).localeCompare(String(b.id)));
		}
	}
}

/** 같은 프로바이더의 기존 모델에서 옮길 수 있는 설정만 물려받는다. */
function inheritDefinition(modelId: string, candidate: Candidate): ModelDefinition {
	const { bases } = candidate;
	const basis =
		bases.find((item) => item.id === modelId) ??
		bases.find((item) => candidate.config?.api !== undefined && item.api === candidate.config.api) ??
		bases[0];

	const definition: ModelDefinition = { id: modelId };
	if (!basis) {
		definition.contextWindow = FALLBACK_CONTEXT_WINDOW;
		definition.maxTokens = FALLBACK_MAX_TOKENS;
		return definition;
	}

	if (basis.reasoning !== undefined) definition.reasoning = basis.reasoning;
	if (basis.thinkingLevelMap !== undefined) definition.thinkingLevelMap = basis.thinkingLevelMap;
	if (basis.input !== undefined) definition.input = basis.input;
	if (basis.cost !== undefined) definition.cost = basis.cost;
	if (basis.samplingParams !== undefined) definition.samplingParams = basis.samplingParams;
	if (basis.headers !== undefined) definition.headers = basis.headers;
	if (basis.compat !== undefined) definition.compat = basis.compat;
	// baseUrl·api 는 프로바이더 수준에 있으면 모델마다 되풀이하지 않는다.
	if (basis.api !== undefined && candidate.config?.api === undefined) definition.api = basis.api;

	definition.contextWindow = basis.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
	definition.maxTokens = basis.maxTokens ?? FALLBACK_MAX_TOKENS;
	return definition;
}

/* ------------------------------------------------------------------ */
/* 프로바이더 후보 모으기                                              */
/* ------------------------------------------------------------------ */

/**
 * 후보는 models.json 의 프로바이더로 한다. 이 파일이 이 명령의 쓰기 대상이고,
 * 사용자가 실제로 쓰는 엔드포인트가 여기에 있기 때문이다.
 * 파일이 비어 있으면(빌트인만 쓰는 경우) 인증이 준비된 프로바이더로 대체한다.
 */
function collectCandidates(ctx: ExtensionCommandContext, modelId: string): Candidate[] {
	const data = readModelsFile();
	const fromFile = Object.entries(data.providers).map(([name, config]) => ({
		name,
		config,
		hasModel: (config.models ?? []).some((model) => model.id === modelId),
		bases: (config.models ?? []) as ModelBasis[],
		basisSource: "models.json",
	}));
	if (fromFile.length > 0) return fromFile;

	// 파일에 프로바이더가 없을 때만 ruo 카탈로그를 참고한다.
	const grouped = new Map<string, ModelBasis[]>();
	const baseUrls = new Map<string, string>();
	for (const model of ctx.modelRegistry.getAvailable()) {
		const list = grouped.get(model.provider) ?? [];
		list.push({
			id: model.id,
			api: model.api,
			reasoning: model.reasoning,
			thinkingLevelMap: model.thinkingLevelMap,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			headers: model.headers,
			compat: model.compat,
		});
		grouped.set(model.provider, list);
		if (typeof model.baseUrl === "string" && model.baseUrl.length > 0) {
			baseUrls.set(model.provider, model.baseUrl);
		}
	}

	return [...grouped.entries()].map(([name, bases]) => ({
		name,
		// baseUrl 을 함께 적어 두어야 다음 로드에서 모델이 확실히 해석된다.
		config: baseUrls.has(name) ? { baseUrl: baseUrls.get(name) } : undefined,
		hasModel: bases.some((basis) => basis.id === modelId),
		bases,
		basisSource: "ruo 카탈로그",
	}));
}

function toSelectItems(candidates: Candidate[]): SelectItem[] {
	return candidates.map((candidate) => {
		const badges: string[] = [];
		if (candidate.hasModel) badges.push("has");
		if (candidate.config === undefined) badges.push("새 항목");
		const baseUrl = candidate.config?.baseUrl;
		return {
			value: candidate.name,
			label: badges.length > 0 ? `${candidate.name}  [${badges.join(" · ")}]` : candidate.name,
			description: typeof baseUrl === "string" && baseUrl.length > 0 ? baseUrl : "models.json 에 없음",
		};
	});
}

/* ------------------------------------------------------------------ */
/* 프로바이더 선택 UI                                                  */
/* ------------------------------------------------------------------ */

/**
 * 검색 입력과 프로바이더 목록을 한 화면에 담은 선택기.
 * ↑↓ 로 이동하고, 글자를 치면 목록이 좁혀진다. Enter 로 확정, Esc 로 취소한다.
 * Esc 는 검색어가 있으면 먼저 지운다.
 */
async function selectProvider(
	ctx: ExtensionCommandContext,
	modelId: string,
	items: SelectItem[],
): Promise<string | undefined> {
	// 같은 ID가 이미 있는 프로바이더를 기본 커서 위치로 둔다.
	const preferred = items.findIndex((item) => item.label.includes("[has]"));
	const maxVisible = 10;

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let query = "";
		let selected = preferred >= 0 ? preferred : 0;

		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold(`프로바이더 선택 — ${modelId}`)), 0, 0));
		container.addChild(
			new Text(theme.fg("muted", "고른 프로바이더의 모델로 추가하고 /model 에 바로 반영합니다."), 0, 0),
		);
		container.addChild(new Spacer(1));

		const search = new Input({ placeholder: "프로바이더 이름·baseUrl 로 검색" });
		search.focused = true;
		search.onEscape = () => done(undefined);
		container.addChild(search);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("dim", "↑↓ 이동 · Enter 선택 · Esc 취소 · 타이핑으로 검색"), 0, 0),
		);
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

		/** 이름과 baseUrl 을 함께 보고 좁힌다. */
		const matches = (): SelectItem[] =>
			query
				? fuzzyFilter(items, query, (item) => `${item.value} ${item.description ?? ""}`)
				: items;

		const redraw = (): void => {
			const visible = matches();
			if (selected > visible.length - 1) selected = Math.max(0, visible.length - 1);

			listContainer.clear();
			const start = Math.max(
				0,
				Math.min(selected - Math.floor(maxVisible / 2), visible.length - maxVisible),
			);
			const end = Math.min(start + maxVisible, visible.length);

			for (let i = start; i < end; i++) {
				const item = visible[i];
				if (!item) continue;
				const isSelected = i === selected;
				const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
				const label = isSelected ? theme.fg("accent", item.label) : item.label;
				const description = item.description ? `  ${theme.fg("muted", item.description)}` : "";
				listContainer.addChild(new Text(`${cursor}${label}${description}`, 0, 0));
			}

			if (visible.length === 0) {
				listContainer.addChild(new Text(theme.fg("warning", "  조건에 맞는 프로바이더가 없습니다"), 0, 0));
			} else if (start > 0 || end < visible.length) {
				listContainer.addChild(new Text(theme.fg("dim", `  (${selected + 1}/${visible.length})`), 0, 0));
			}
		};

		redraw();

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const kb = getKeybindings();
				const visible = matches();

				if (kb.matches(data, "tui.select.up")) {
					if (visible.length > 0) selected = selected === 0 ? visible.length - 1 : selected - 1;
				} else if (kb.matches(data, "tui.select.down")) {
					if (visible.length > 0) selected = selected === visible.length - 1 ? 0 : selected + 1;
				} else if (kb.matches(data, "tui.select.confirm")) {
					const item = visible[selected];
					if (item) {
						done(item.value);
						return;
					}
				} else if (kb.matches(data, "tui.select.cancel")) {
					// 검색어가 있으면 먼저 지우고, 비어 있으면 취소한다.
					if (query.length > 0) {
						search.setValue("");
						query = "";
						selected = 0;
					} else {
						done(undefined);
						return;
					}
				} else {
					search.handleInput(data);
					if (search.getValue() !== query) {
						query = search.getValue();
						// 검색어가 바뀌면 가장 잘 맞는 항목으로 커서를 올린다.
						selected = 0;
					}
				}

				redraw();
				tui.requestRender();
			},
			// IME 커서가 검색창을 따라가도록 포커스를 위임한다.
			get focused() {
				return search.focused;
			},
			set focused(value: boolean) {
				search.focused = value;
			},
		};
	});
}

/* ------------------------------------------------------------------ */
/* 등록                                                                */
/* ------------------------------------------------------------------ */

interface RegisterOutcome {
	definition: ModelDefinition;
	replacedExisting: boolean;
	backupPath?: string;
	/** 카탈로그 새로고침이 실패했을 때의 사유. */
	refreshWarning?: string;
}

/**
 * models.json 에 모델을 넣고 ruo 카탈로그를 다시 읽힌다.
 * 프로바이더 설정은 기존 값을 그대로 두고 `models` 에만 손댄다.
 */
async function addModelToProvider(
	ctx: ExtensionCommandContext,
	modelId: string,
	candidate: Candidate,
): Promise<RegisterOutcome> {
	const file = getModelsPath();
	const data = readModelsFile();

	// 선택 화면을 띄우는 사이에 파일이 바뀌었을 수 있으므로 최신 상태를 다시 본다.
	const liveConfig: ProviderConfig = data.providers[candidate.name] ?? { ...(candidate.config ?? {}) };
	const hasBaseUrl = typeof liveConfig.baseUrl === "string" && liveConfig.baseUrl.length > 0;
	if (!hasBaseUrl && candidate.basisSource === "models.json") {
		throw new Error(`프로바이더 "${candidate.name}" 에 baseUrl 이 없습니다. models.json 을 먼저 확인하세요.`);
	}

	const existingModels = liveConfig.models ?? [];
	const replacedExisting = existingModels.some((model) => model.id === modelId);

	// 파일에 있던 모델을 우선 기준으로 삼아 설정을 물려받는다.
	const enriched: Candidate = {
		...candidate,
		config: liveConfig,
		bases: [...existingModels, ...candidate.bases],
	};
	const definition = inheritDefinition(modelId, enriched);

	const nextConfig: ProviderConfig = { ...liveConfig };
	nextConfig.models = [...existingModels.filter((model) => model.id !== modelId), definition];
	// 프로바이더 수준 api 가 없으면 방금 정한 api 로 채워 다음 로드에서 확실히 해석되게 한다.
	if (nextConfig.api === undefined && definition.api !== undefined) nextConfig.api = definition.api;

	data.providers[candidate.name] = nextConfig;
	sortModelList(data.providers);

	const backupPath = backupModelsFile();
	try {
		writeJsonAtomic(file, data);
	} catch (error) {
		throw new Error(
			`models.json 기록에 실패했습니다: ${error instanceof Error ? error.message : String(error)}\n${file}`,
		);
	}

	// 파일만 고치면 pi의 카탈로그는 아직 그대로다. 네트워크 없이 다시 읽혀 반영한다.
	let refreshWarning: string | undefined;
	try {
		const result = await ctx.modelRegistry.refresh({ providers: [candidate.name], allowNetwork: false });
		const providerError = result.errors.get(candidate.name);
		if (providerError) refreshWarning = providerError.message;
		else if (result.aborted) refreshWarning = "카탈로그 새로고침이 중단되었습니다.";
	} catch (error) {
		refreshWarning = error instanceof Error ? error.message : String(error);
	}

	return { definition, replacedExisting, backupPath, refreshWarning };
}

/* ------------------------------------------------------------------ */
/* 명령 등록                                                           */
/* ------------------------------------------------------------------ */

export default function addModelExtension(pi: ExtensionAPI): void {
	pi.registerCommand("addmodel", {
		description: "모델을 프로바이더에 추가하고 /model 에서 쓸 수 있게 합니다",
		handler: async (args, ctx) => {
			const fromArgs = args.trim();
			const modelId = fromArgs
				? fromArgs
				: ((await ctx.ui.input("모델 ID", "예: deepseek-v4-pro")) ?? "").trim();

			if (!modelId) {
				ctx.ui.notify("모델 ID가 필요합니다. 사용법: /addmodel {model_id}", "warning");
				return;
			}

			let candidates: Candidate[];
			try {
				candidates = collectCandidates(ctx, modelId);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			if (candidates.length === 0) {
				ctx.ui.notify(
					"고를 프로바이더가 없습니다. models.json 에 baseUrl/apiKey 를 가진 프로바이더를 추가하거나 /login 하세요.",
					"warning",
				);
				return;
			}

			const selected = await selectProvider(ctx, modelId, toSelectItems(candidates));
			if (!selected) return; // 사용자가 취소했다.

			const candidate = candidates.find((item) => item.name === selected);
			if (!candidate) return;

			let outcome: RegisterOutcome;
			try {
				outcome = await addModelToProvider(ctx, modelId, candidate);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			// 실제로 쓸 수 있게 됐는지 카탈로그에 직접 물어본다.
			const inCatalog = ctx.modelRegistry.find(candidate.name, modelId) !== undefined;
			const usable = ctx.modelRegistry
				.getAvailable()
				.some((entry) => entry.provider === candidate.name && entry.id === modelId);

			const notes: string[] = [];
			if (outcome.replacedExisting) notes.push("기존 정의를 대체함");
			notes.push(
				`ctx ${outcome.definition.contextWindow ?? FALLBACK_CONTEXT_WINDOW} / max ${outcome.definition.maxTokens ?? FALLBACK_MAX_TOKENS}`,
			);
			if (outcome.backupPath) notes.push(`백업 ${path.basename(outcome.backupPath)}`);
			const suffix = notes.length > 0 ? ` (${notes.join(" · ")})` : "";

			if (!inCatalog || !usable) {
				ctx.ui.notify(
					`models.json 에는 기록했지만 아직 목록에 없습니다${suffix}\n` +
						`${outcome.refreshWarning ? `사유: ${outcome.refreshWarning}\n` : ""}/reload 하거나 /model 을 다시 열어 보세요.`,
					"warning",
				);
				return;
			}

			ctx.ui.notify(`${candidate.name}/${modelId} 추가됨 — /model 에서 선택할 수 있습니다${suffix}`, "info");

			// 모델 스코프가 걸린 세션이면 새 모델이 Ctrl+P 순환 목록에 없을 수 있다.
			if (
				ctx.scopedModels.length > 0 &&
				!ctx.scopedModels.some(
					(scoped) => scoped.model.provider === candidate.name && scoped.model.id === modelId,
				)
			) {
				ctx.ui.notify(
					"이 세션에는 모델 스코프가 지정돼 있어 새 모델이 Ctrl+P 순환에 없습니다. settings.json 의 enabledModels 또는 /scoped-models 를 확인하세요.",
					"warning",
				);
			}
		},
	});
}



