/**
 * @fileoverview `wunderland list-personas` — display available AgentOS personas.
 * @module wunderland/cli/commands/list-personas
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { GlobalFlags } from '../types.js';
import { accent, dim, info, muted } from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import { printTable } from '../ui/table.js';
import { resolveEffectiveAgentConfig } from '../../config/effective-agent-config.js';
import type { WunderlandAgentConfig } from '../../api/types.js';

export default async function cmdListPersonas(
  _args: string[],
  flags: Record<string, string | boolean>,
  _globals: GlobalFlags,
): Promise<void> {
  const format = typeof flags['format'] === 'string' ? flags['format'] : 'table';
  const localConfigPath = path.resolve(process.cwd(), 'agent.config.json');

  let agentConfig: WunderlandAgentConfig = {
    personaRegistry: { enabled: true },
  };

  if (existsSync(localConfigPath)) {
    try {
      agentConfig = JSON.parse(await readFile(localConfigPath, 'utf8')) as WunderlandAgentConfig;
    } catch {
      // Fall back to built-ins only.
    }
  }

  const { selectedPersona, availablePersonas } = await resolveEffectiveAgentConfig({
    agentConfig,
    workingDirectory: process.cwd(),
  });
  const personas = availablePersonas ?? [];

  if (format === 'json') {
    console.log(JSON.stringify({
      selectedPersona,
      personas,
    }, null, 2));
    return;
  }

  if (personas.length === 0) {
    fmt.note('No AgentOS personas found. Add persona JSON files under ./personas or enable built-ins in personaRegistry.');
    fmt.blank();
    return;
  }

  printTable({
    title: 'AgentOS Personas',
    compact: true,
    columns: [
      { label: 'ID', width: 28 },
      { label: 'Name', width: 24 },
      { label: 'Source', width: 10 },
      { label: 'Model', width: 16 },
      { label: 'RAG', width: 14 },
      { label: 'Selection' },
    ],
    rows: personas.map((persona) => {
      const isSelected = selectedPersona?.id === persona.id;
      const model = [persona.defaultProviderId, persona.defaultModelId].filter(Boolean).join('/') || '-';
      const ragLabel = persona.rag?.enabled
        ? `${persona.rag.strategy ?? 'on'}${persona.rag.collectionIds?.length ? `:${persona.rag.collectionIds.length}` : ''}`
        : 'off';
      return [
        isSelected ? accent(persona.id) : persona.id,
        isSelected ? accent(persona.name) : persona.name,
        muted(persona.source),
        model === '-' ? dim('-') : info(model),
        persona.rag?.enabled ? info(ragLabel) : dim('off'),
        isSelected ? accent('selected') : dim(''),
      ];
    }),
  });

  fmt.blank();
  if (selectedPersona) {
    fmt.kvPair('Selected', `${accent(selectedPersona.name)} ${dim(`(${selectedPersona.id})`)}`);
  } else {
    fmt.note(`Set ${accent('selectedPersonaId')} in ${accent('agent.config.json')} to activate one.`);
  }
  fmt.blank();
}
