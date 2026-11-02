#!/usr/bin/env node
import { APP_NAME } from "./config.js";
import { configureHttpDispatcher } from "./core/http-dispatcher.js";
import { main } from "./main.js";
process.title = `${APP_NAME}-rpc`;
process.env.RUO_CODING_AGENT_DIR===void 0&&process.env.PI_CODING_AGENT_DIR!==void 0&&(process.env.RUO_CODING_AGENT_DIR=process.env.PI_CODING_AGENT_DIR);process.env.RUO_CODING_AGENT_SESSION_DIR===void 0&&process.env.PI_CODING_AGENT_SESSION_DIR!==void 0&&(process.env.RUO_CODING_AGENT_SESSION_DIR=process.env.PI_CODING_AGENT_SESSION_DIR);process.env.RUO_CODING_AGENT = "true";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "ruo";
process.emitWarning = (() => { });
configureHttpDispatcher();
main(["--mode", "rpc", ...process.argv.slice(2)]);
//# sourceMappingURL=rpc-entry.js.map