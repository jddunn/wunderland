import { confirm, intro, note, outro } from "@clack/prompts";

import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import type { ClawdisConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDIS,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, sleep } from "../utils.js";
import { healthCommand } from "./health.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  guardCancel,
  printWizardHeader,
} from "./onboard-helpers.js";

function resolveMode(cfg: ClawdisConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

export async function doctorCommand(runtime: RuntimeEnv = defaultRuntime) {
  printWizardHeader(runtime);
  intro("Clawdis doctor");

  const snapshot = await readConfigFileSnapshot();
  let cfg: ClawdisConfig = snapshot.valid ? snapshot.config : {};
  if (snapshot.exists && !snapshot.valid) {
    note("Config invalid; doctor will run with defaults.", "Config");
  }

  const workspaceDir = resolveUserPath(
    cfg.agent?.workspace ?? DEFAULT_WORKSPACE,
  );
  const skillsReport = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  note(
    [
      `Eligible: ${skillsReport.skills.filter((s) => s.eligible).length}`,
      `Missing requirements: ${
        skillsReport.skills.filter(
          (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
        ).length
      }`,
      `Blocked by allowlist: ${
        skillsReport.skills.filter((s) => s.blockedByAllowlist).length
      }`,
    ].join("\n"),
    "Skills status",
  );

  let healthOk = false;
  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    healthOk = true;
  } catch (err) {
    runtime.error(`Health check failed: ${String(err)}`);
  }

  if (!healthOk) {
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (!loaded) {
      note("Gateway daemon not installed.", "Gateway");
    } else {
      const restart = guardCancel(
        await confirm({
          message: "Restart gateway daemon now?",
          initialValue: true,
        }),
        runtime,
      );
      if (restart) {
        await service.restart({ stdout: process.stdout });
        await sleep(1500);
        try {
          await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
        } catch (err) {
          runtime.error(`Health check failed: ${String(err)}`);
        }
      }
    }
  }

  cfg = applyWizardMetadata(cfg, { command: "doctor", mode: resolveMode(cfg) });
  await writeConfigFile(cfg);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDIS}`);

  outro("Doctor complete.");
}
