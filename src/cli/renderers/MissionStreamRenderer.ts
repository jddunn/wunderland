// @ts-nocheck
/**
 * @file MissionStreamRenderer.ts
 * @description Colored terminal renderer for the MissionEvent stream.
 *
 * Four output modes:
 *   default  — streaming text with colored role prefixes, inline status
 *   verbose  — adds planning phases, scores, checkpoints, token counts
 *   json     — one JSON event per line (for piping to dashboards)
 *   quiet    — final output + cost summary only
 */

/** ANSI escape codes. */
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
} as const;

export type OutputMode = 'default' | 'verbose' | 'json' | 'quiet';

/**
 * Renders mission events to stdout with colored output.
 *
 * Events are typed as `{ type: string; [k: string]: unknown }` to avoid
 * hard-coupling to the `@framers/agentos` GraphEvent type, which may not
 * be resolvable in all build configurations.
 */
export class MissionStreamRenderer {
  private readonly mode: OutputMode;
  private currentAgent = '';

  constructor(mode: OutputMode = 'default') {
    this.mode = mode;
  }

  /** Render a single event to stdout. */
  render(event: { type: string; [k: string]: unknown }): void {
    if (this.mode === 'json') {
      process.stdout.write(JSON.stringify(event) + '\n');
      return;
    }

    const t = event.type;

    // -- Planning events --

    if (t === 'mission:planning_start') {
      if (this.mode !== 'quiet') {
        console.log(`\n${C.bold}${C.cyan}🎯 Mission:${C.reset} "${event.goal}"`);
      }
      return;
    }

    if (t === 'mission:branch_generated' && this.mode === 'verbose') {
      console.log(`${C.dim}  📊 Branch ${event.branchId}: ${event.summary}${C.reset}`);
      return;
    }

    if (t === 'mission:branch_selected') {
      if (this.mode !== 'quiet') {
        console.log(`${C.green}  ✓ Selected: ${event.reason}${C.reset}`);
      }
      return;
    }

    if (t === 'mission:refinement_applied' && this.mode === 'verbose') {
      const changes = event.changes as string[];
      for (const change of changes) {
        console.log(`${C.dim}  🔧 Refinement: ${change}${C.reset}`);
      }
      return;
    }

    if (t === 'mission:graph_compiled') {
      if (this.mode !== 'quiet') {
        const cost = (event.estimatedCost as number).toFixed(2);
        console.log(
          `${C.green}  ✓ Plan: ${event.nodeCount} agents, est. $${cost}${C.reset}`,
        );
        console.log(`${C.dim}${'━'.repeat(50)}${C.reset}`);
      }
      return;
    }

    // -- Execution events --

    if (t === 'mission:agent_spawned') {
      if (this.mode !== 'quiet') {
        console.log(
          `${C.magenta}  🚀 Spawned ${event.role} (${event.provider}/${event.model})${C.reset}`,
        );
      }
      return;
    }

    if (t === 'text_delta') {
      if (this.mode === 'quiet') return;
      const nodeId = String(event.nodeId ?? '');
      if (nodeId !== this.currentAgent) {
        this.currentAgent = nodeId;
        process.stdout.write(`\n${C.bold}[${nodeId}]${C.reset} `);
      }
      process.stdout.write(String(event.content ?? ''));
      return;
    }

    if (t === 'tool_call') {
      if (this.mode !== 'quiet') {
        console.log(
          `\n${C.yellow}  ⚡ tool_call: ${event.toolName}(...)${C.reset}`,
        );
      }
      return;
    }

    // -- Expansion events --

    if (t === 'mission:expansion_proposed') {
      if (this.mode !== 'quiet') {
        const reason =
          (typeof event.reason === 'string' && event.reason) ||
          ((event.patch as { reason?: unknown } | undefined)?.reason as string | undefined) ||
          'expansion proposed';
        console.log(`${C.blue}  🔧 expansion proposed: ${reason}${C.reset}`);
      }
      return;
    }

    if (t === 'mission:expansion_approved') {
      if (this.mode !== 'quiet') {
        const who = event.by === 'auto' ? 'auto-approved' : 'approved by user';
        console.log(`${C.green}  ✓ ${who}${C.reset}`);
      }
      return;
    }

    if (t === 'mission:expansion_rejected') {
      if (this.mode !== 'quiet') {
        console.log(`${C.red}  ✗ rejected: ${event.reason}${C.reset}`);
      }
      return;
    }

    if (t === 'mission:tool_forged') {
      if (this.mode !== 'quiet') {
        console.log(
          `${C.magenta}  🔧 tool forged: ${event.name} (${event.mode} mode)${C.reset}`,
        );
      }
      return;
    }

    // -- Cost and threshold events --

    if (t === 'mission:cost_update') {
      if (this.mode !== 'quiet') {
        const spent = (event.totalSpent as number).toFixed(2);
        const cap = (event.costCap as number).toFixed(2);
        console.log(`${C.dim}  💰 $${spent} / $${cap}${C.reset}`);
      }
      return;
    }

    if (t === 'mission:threshold_reached') {
      console.log(
        `${C.red}  ⚠️  Threshold reached: ${event.threshold} (${event.value}/${event.cap})${C.reset}`,
      );
      return;
    }

    if (t === 'mission:approval_required') {
      console.log(
        `${C.yellow}${C.bold}  ⏸️  Approval required: ${event.action}${C.reset}`,
      );
      return;
    }

    // -- Completion --

    if (t === 'mission:complete') {
      const duration = ((event.totalDurationMs as number) / 1000).toFixed(1);
      const cost = (event.totalCost as number).toFixed(2);
      console.log(`\n${C.dim}${'━'.repeat(50)}${C.reset}`);
      console.log(`${C.green}${C.bold}✅ Mission complete${C.reset}`);
      console.log(`   Duration: ${duration}s`);
      console.log(`   Cost: $${cost}`);
      console.log(`   Agents: ${event.agentCount}`);
      return;
    }

    // -- Verbose-only events --

    if (this.mode === 'verbose') {
      if (t === 'node_start') {
        console.log(`${C.dim}  → node_start: ${event.nodeId}${C.reset}`);
      }
      if (t === 'node_end') {
        console.log(
          `${C.dim}  ← node_end: ${event.nodeId} (${event.durationMs}ms)${C.reset}`,
        );
      }
      if (t === 'checkpoint_saved') {
        console.log(`${C.dim}  💾 checkpoint: ${event.checkpointId}${C.reset}`);
      }
    }
  }
}
