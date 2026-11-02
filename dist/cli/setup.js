import { APP_NAME } from "../config.js";
import { configureHttpDispatcher } from "../core/http-dispatcher.js";
export function setupCli() {
    process.title = APP_NAME;
    process.env.RUO_CODING_AGENT_DIR===void 0&&process.env.PI_CODING_AGENT_DIR!==void 0&&(process.env.RUO_CODING_AGENT_DIR=process.env.PI_CODING_AGENT_DIR);process.env.RUO_CODING_AGENT_SESSION_DIR===void 0&&process.env.PI_CODING_AGENT_SESSION_DIR!==void 0&&(process.env.RUO_CODING_AGENT_SESSION_DIR=process.env.PI_CODING_AGENT_SESSION_DIR);process.env.RUO_CODING_AGENT = "true";
    process.env.PI_CODING_AGENT = "true";
    process.env.AI_AGENT = "ruo";
    process.emitWarning = (() => { });
    // Configure undici before provider SDKs issue requests. Settings are applied
    // once SettingsManager has loaded global/project configuration.
    configureHttpDispatcher();
}
//# sourceMappingURL=setup.js.map