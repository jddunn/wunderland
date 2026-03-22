import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface SecretPromptResult {
  key: string;
  envVar: string;
  value: string;
  persisted: boolean;
}

interface SecretRequirement {
  id: string;
  envVar: string;
  signupUrl?: string;
  freeTier?: string;
}

/**
 * Prompts user for missing API keys required by an extension.
 * Persists entered values to .env in the project root.
 */
export async function promptForMissingSecrets(
  secrets: SecretRequirement[],
  opts?: { cwd?: string; nonInteractive?: boolean },
): Promise<SecretPromptResult[]> {
  const results: SecretPromptResult[] = [];
  const envPath = join(opts?.cwd ?? process.cwd(), '.env');

  // Parse existing .env to avoid duplicates
  const existing = parseEnvFile(envPath);

  for (const secret of secrets) {
    // Skip if already in environment or .env
    if (process.env[secret.envVar] || existing[secret.envVar]) continue;

    if (opts?.nonInteractive) {
      console.log(`  ⚠ ${secret.envVar} required — set it in .env or environment`);
      continue;
    }

    console.log(`\n  ${secret.id} requires ${secret.envVar}`);
    if (secret.signupUrl) console.log(`  Sign up: ${secret.signupUrl}`);
    if (secret.freeTier) console.log(`  Free tier: ${secret.freeTier}`);

    const value = await askLine(`  Enter ${secret.envVar} (or press Enter to skip): `);
    if (!value) continue;

    // Append to .env
    const line = `\n# Added by wunderland marketplace install\n${secret.envVar}=${value}\n`;
    appendFileSync(envPath, line, 'utf8');
    process.env[secret.envVar] = value;

    results.push({
      key: secret.id,
      envVar: secret.envVar,
      value,
      persisted: true,
    });
  }

  return results;
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return vars;
}

function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
