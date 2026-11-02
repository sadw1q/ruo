import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "ruo-1mcontext";
const CONTEXT_WINDOW = 1_000_000;

type EnabledModel = { provider: string; id: string };

export default function contextExtension(pi: ExtensionAPI): void {
	function isEnabled(ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) return false;
			const data = entry.data as EnabledModel | undefined;
			return data?.provider === ctx.model?.provider && data?.id === ctx.model?.id;
		});
	}

	async function restore(_event: unknown, ctx: ExtensionContext): Promise<void> {
		const model = ctx.model;
		if (!model || !isEnabled(ctx)) {
			ctx.ui.setStatus(STATE_TYPE, undefined);
			return;
		}
		if (model.contextWindow < CONTEXT_WINDOW) {
			if (!(await pi.setModel({ ...model, contextWindow: CONTEXT_WINDOW }))) {
				ctx.ui.setStatus(STATE_TYPE, undefined);
				ctx.ui.notify("1M 컨텍스트 복원 실패: 모델 공급자 인증 설정을 확인하세요.", "error");
				return;
			}
		}
		ctx.ui.setStatus(STATE_TYPE, "1M context");
	}

	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("model_select", restore);

	pi.registerCommand("1mcontext", {
		description: "현재 세션의 현재 모델에 1M 토큰 컨텍스트 활성화",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("응답이 끝난 뒤 /1mcontext를 실행하세요.", "warning");
				return;
			}
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("먼저 사용할 모델을 선택하세요.", "error");
				return;
			}
			if (model.contextWindow < CONTEXT_WINDOW) {
				if (!(await pi.setModel({ ...model, contextWindow: CONTEXT_WINDOW }))) {
					ctx.ui.notify("1M 컨텍스트 활성화 실패: 모델 공급자 인증 설정을 확인하세요.", "error");
					return;
				}
			}
			if (!isEnabled(ctx)) {
				pi.appendEntry<EnabledModel>(STATE_TYPE, { provider: model.provider, id: model.id });
			}
			ctx.ui.setStatus(STATE_TYPE, "1M context");
			ctx.ui.notify(`${model.provider}/${model.id}: 이 세션에서 1M 컨텍스트를 활성화했습니다. 실제 입력 한도는 서버의 모델 지원에 따릅니다.`, "info");
		},
	});
}
