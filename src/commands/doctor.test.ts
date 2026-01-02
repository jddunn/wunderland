import { describe, expect, it, vi } from "vitest";

const readConfigFileSnapshot = vi.fn();
const writeConfigFile = vi.fn().mockResolvedValue(undefined);
const validateConfigObject = vi.fn((raw: unknown) => ({
  ok: true as const,
  config: raw as Record<string, unknown>,
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: () => ({ skills: [] }),
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH_CLAWDIS: "/tmp/clawdis.json",
  readConfigFileSnapshot,
  writeConfigFile,
  validateConfigObject,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: () => {},
    error: () => {},
    exit: () => {
      throw new Error("exit");
    },
  },
}));

vi.mock("../utils.js", () => ({
  resolveUserPath: (value: string) => value,
  sleep: vi.fn(),
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./onboard-helpers.js", () => ({
  applyWizardMetadata: (cfg: Record<string, unknown>) => cfg,
  DEFAULT_WORKSPACE: "/tmp",
  guardCancel: (value: unknown) => value,
  printWizardHeader: vi.fn(),
}));

describe("doctor", () => {
  it("migrates routing.allowFrom to whatsapp.allowFrom", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/clawdis.json",
      exists: true,
      raw: "{}",
      parsed: { routing: { allowFrom: ["+15555550123"] } },
      valid: false,
      config: {},
      issues: [
        {
          path: "routing.allowFrom",
          message: "legacy",
        },
      ],
      legacyIssues: [
        {
          path: "routing.allowFrom",
          message: "legacy",
        },
      ],
    });

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect((written.whatsapp as Record<string, unknown>)?.allowFrom).toEqual([
      "+15555550123",
    ]);
    expect(written.routing).toBeUndefined();
  });
});
