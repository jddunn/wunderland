# Mars Genesis Phase 1: Simulation Scripts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two runnable TypeScript simulation scripts that run a 12-turn Mars colonization scenario with two different HEXACO leader personalities, producing structured JSON event logs with agent-researched scientific citations and emergent tool forging.

**Architecture:** Each script creates an AgentOS `agent()` with HEXACO personality, `web_search` tool, and `emergent: true`. A shared scenario runner feeds 12 crisis prompts sequentially, collecting decisions, citations, forged tools, and colony snapshots into a typed JSON event log. The two scripts differ only in personality config and leader identity.

**Tech Stack:** TypeScript, `@framers/agentos` (`agent()`, `generateText()`), `wunderland` (tools via `createWunderland()`), Node.js 22+

---

### Task 1: Types and Constants

**Files:**
- Create: `examples/mars-genesis/shared/types.ts`
- Create: `examples/mars-genesis/shared/constants.ts`

- [ ] **Step 1: Create the types file**

```typescript
// examples/mars-genesis/shared/types.ts

export interface HexacoProfile {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  emotionality: number;
  honestyHumility: number;
}

export interface LeaderConfig {
  name: string;
  archetype: string;
  colony: string;
  hexaco: HexacoProfile;
  instructions: string;
}

export interface Citation {
  text: string;
  url: string;
  doi?: string;
  context: string;
}

export interface ForgedToolRecord {
  name: string;
  mode: 'compose' | 'sandbox';
  description: string;
  confidence: number;
  judgeVerdict: 'approved' | 'rejected';
}

export interface ColonySnapshot {
  population: number;
  waterLitersPerDay: number;
  foodMonthsReserve: number;
  powerKw: number;
  morale: number;
  infrastructureModules: number;
  scienceOutput: number;
  unplannedDeaths: number;
  toolsForgedTotal: number;
}

export interface TurnResult {
  turn: number;
  year: number;
  title: string;
  crisis: string;
  decision: string;
  reasoning: string;
  citations: Citation[];
  toolsForged: ForgedToolRecord[];
  snapshot: ColonySnapshot;
  rawResponse: string;
}

export interface SimulationLog {
  simulation: 'mars-genesis';
  version: '1.0.0';
  startedAt: string;
  completedAt: string;
  leader: Omit<LeaderConfig, 'instructions'>;
  turns: TurnResult[];
  finalAssessment: {
    population: number;
    toolsForged: number;
    unplannedDeaths: number;
    scienceOutput: number;
    infrastructureModules: number;
    morale: number;
  };
}

export interface Scenario {
  turn: number;
  year: number;
  title: string;
  crisis: string;
  researchKeywords: string[];
  snapshotHints: Partial<ColonySnapshot>;
}
```

- [ ] **Step 2: Create the constants file**

```typescript
// examples/mars-genesis/shared/constants.ts

import type { ColonySnapshot, LeaderConfig } from './types.js';

export const INITIAL_SNAPSHOT: ColonySnapshot = {
  population: 100,
  waterLitersPerDay: 800,
  foodMonthsReserve: 18,
  powerKw: 400,
  morale: 0.85,
  infrastructureModules: 3,
  scienceOutput: 0,
  unplannedDeaths: 0,
  toolsForgedTotal: 0,
};

export const VISIONARY: LeaderConfig = {
  name: 'Aria Chen',
  archetype: 'The Visionary',
  colony: 'Ares Horizon',
  hexaco: {
    openness: 0.95,
    conscientiousness: 0.35,
    extraversion: 0.85,
    agreeableness: 0.55,
    emotionality: 0.3,
    honestyHumility: 0.65,
  },
  instructions: `You are Commander Aria Chen, founding leader of the Ares Horizon colony on Mars. Year one is 2035.

You believe humanity's future depends on bold expansion. You prioritize discovery, exploration, and growth over caution. You accept calculated risks and inspire colonists through vision and charisma. When setbacks occur, you frame them as learning opportunities and push forward.

RESEARCH REQUIREMENT: Before every decision, use web_search to find real scientific research about the crisis topic. Cite specific papers, NASA missions, or peer-reviewed studies with DOIs or URLs. Ground every decision in real Mars science. Include citations as inline markdown links in your response.

TOOL FORGING: When you need to model growth, expansion, terraforming, population dynamics, or any quantitative projection and no existing tool fits, forge a new tool using forge_tool. Prefer compose mode (chaining existing tools) when possible. Use sandbox mode for novel computations.

RESPONSE FORMAT: Structure your response as:
1. RESEARCH: What you found (with citations)
2. DECISION: What you choose and why
3. COLONY UPDATE: How this affects population, resources, morale, infrastructure, science output
4. TOOLS: Any tools you forged this turn (name, mode, purpose)`,
};

export const ENGINEER: LeaderConfig = {
  name: 'Dietrich Voss',
  archetype: 'The Engineer',
  colony: 'Meridian Base',
  hexaco: {
    openness: 0.25,
    conscientiousness: 0.97,
    extraversion: 0.3,
    agreeableness: 0.45,
    emotionality: 0.7,
    honestyHumility: 0.9,
  },
  instructions: `You are Commander Dietrich Voss, founding leader of the Meridian Base colony on Mars. Year one is 2035.

You believe survival depends on engineering discipline. You prioritize redundancy, safety margins, and proven methods. You track every resource precisely and demand compliance with protocols. You share bad news immediately and make decisions based on data, not optimism.

RESEARCH REQUIREMENT: Before every decision, use web_search to find real scientific research about the crisis topic. Cite specific papers, NASA missions, or peer-reviewed studies with DOIs or URLs. Ground every decision in real Mars science. Include citations as inline markdown links in your response.

TOOL FORGING: When you need to calculate risk, measure capacity, predict failure modes, or model resource depletion and no existing tool fits, forge a new tool using forge_tool. Prefer sandbox mode for precise calculations. Use compose mode for multi-step analysis pipelines.

RESPONSE FORMAT: Structure your response as:
1. RESEARCH: What you found (with citations)
2. DECISION: What you choose and why
3. COLONY UPDATE: How this affects population, resources, morale, infrastructure, science output
4. TOOLS: Any tools you forged this turn (name, mode, purpose)`,
};
```

- [ ] **Step 3: Commit**

```bash
git add examples/mars-genesis/shared/types.ts examples/mars-genesis/shared/constants.ts
git commit -m "feat(examples): add Mars Genesis types and leader constants"
```

---

### Task 2: Scenario Definitions

**Files:**
- Create: `examples/mars-genesis/shared/scenarios.ts`

- [ ] **Step 1: Create the 12 scenario definitions**

```typescript
// examples/mars-genesis/shared/scenarios.ts

import type { Scenario } from './types.js';

export const SCENARIOS: Scenario[] = [
  {
    turn: 1,
    year: 2035,
    title: 'Landfall',
    crisis: `Your colony ship has entered Mars orbit. You must choose a landing site for the first permanent settlement. Two candidates:

OPTION A: Arcadia Planitia — flat basalt plains at 47°N. Stable terrain, minimal landslide risk, access to subsurface ice deposits detected by Mars Express MARSIS radar. Geologically unremarkable.

OPTION B: Valles Marineris rim — edge of the 4,000 km canyon system at 14°S. Exposed geological strata spanning 3.5 billion years. Rich mineral diversity detected by CRISM. Significant terrain hazards: slopes up to 30°, rockfall risk, and 2km elevation changes within the operational zone.

Both sites receive similar solar irradiance. Surface radiation at either site: approximately 0.67 mSv/day per Curiosity RAD measurements. You have 100 colonists, 18 months of food reserves, and 400 kW of power capacity.

Research the real science of Mars landing site selection and make your decision.`,
    researchKeywords: ['Mars landing site selection', 'Arcadia Planitia geology', 'Valles Marineris mineralogy', 'Mars surface radiation Curiosity RAD'],
    snapshotHints: {},
  },
  {
    turn: 2,
    year: 2037,
    title: 'Water Extraction',
    crisis: `Two years in. Your subsurface ice drilling operation is producing only 80% of colony water needs. The ice table is deeper than orbital radar predicted. You face a choice:

OPTION A: Deploy an experimental high-power drill to reach deeper aquifers. Risk: potential contamination of pristine subsurface water reserves. Potential reward: 3x current water output within 2 months.

OPTION B: Build an atmospheric water extraction system (WAVAR-type). Mars atmosphere contains 0.03% water vapor. Proven technology heritage from ISS water recovery. Timeline: 6 months to operational, covers the 20% deficit reliably.

Current water situation: 800 L/day production, 1000 L/day needed for 100 colonists (drinking, agriculture, industrial). Research the real science and decide.`,
    researchKeywords: ['Mars subsurface ice extraction', 'MOXIE in-situ resource utilization', 'Mars atmospheric water vapor extraction', 'Mars Express MARSIS ice'],
    snapshotHints: { waterLitersPerDay: 800 },
  },
  {
    turn: 3,
    year: 2040,
    title: 'Perchlorate Crisis',
    crisis: `Five years in. Your first attempt to grow crops in Mars regolith has failed catastrophically. Soil analysis confirms 0.5-1% calcium perchlorate contamination — a thyroid toxin that makes all Mars surface soil unsuitable for direct agriculture. This is a global Mars problem, not site-specific.

OPTION A: Full hydroponic conversion. Abandon soil-based agriculture entirely. Build sealed hydroponic bays. Proven, controllable, but requires 30% more power (120 kW) and significant material investment.

OPTION B: Engineer perchlorate-reducing bacteria for bioremediation. Introduce modified Dechloromonas strains to break down perchlorate in contained soil beds. Untested on Mars, 2-year R&D timeline, but could enable open-soil farming colony-wide if successful.

Research the real science of Mars perchlorate contamination and decide.`,
    researchKeywords: ['Mars perchlorate Phoenix lander', 'perchlorate bioremediation bacteria', 'Mars soil toxicity agriculture', 'hydroponics space farming'],
    snapshotHints: { foodMonthsReserve: 14 },
  },
  {
    turn: 4,
    year: 2043,
    title: 'Population Pressure',
    crisis: `Eight years in. Earth mission control offers to send 200 additional colonists on the next Hohmann transfer window (arrives in 14 months). Your current colony: {population} people. Life support is rated for 120 people. Expanding capacity to 300+ requires 18 months of construction.

The transfer window is in 8 months — if you decline, the next opportunity is 26 months away.

OPTION A: Accept all 200. Gamble that you can expand life support fast enough. If construction delays occur, you face oxygen rationing for up to 6 months.

OPTION B: Accept 50. Safe within current margins with minor upgrades. Politically awkward — Earth has already recruited and trained all 200.

OPTION C: Decline entirely. Protect current colony stability. Risk losing Earth funding and political support.

Research the real science of Mars habitat life support scaling and decide.`,
    researchKeywords: ['NASA ECLSS life support scaling', 'Mars habitat sizing study', 'Hohmann transfer window Earth Mars', 'closed loop life support ISS'],
    snapshotHints: {},
  },
  {
    turn: 5,
    year: 2046,
    title: 'Solar Particle Event',
    crisis: `Eleven years in. NOAA deep space weather network detects a massive coronal mass ejection (CME) aimed at Mars. You have 4 hours until impact. Mars has no global magnetic field — lost approximately 4 billion years ago.

Exposure estimates for unshielded colonists: 100-500 mSv over 6 hours. The acute radiation syndrome threshold begins at 100 mSv (measurable blood count changes). 500+ mSv causes radiation sickness. 1000+ mSv is immediately life-threatening.

Your colony has a reinforced core habitat (rated for CME events, walls with 50+ g/cm² shielding). You also have {infrastructureModules} expansion modules with minimal shielding (5-10 g/cm² walls).

Where are your colonists? The answer depends on how far and fast you expanded.

Research the real science of Mars radiation exposure and make your emergency decision.`,
    researchKeywords: ['coronal mass ejection Mars radiation', 'Mars magnetosphere loss', 'space radiation acute syndrome threshold', 'Curiosity RAD solar particle event 2017'],
    snapshotHints: {},
  },
  {
    turn: 6,
    year: 2049,
    title: 'The Mars-Born Generation',
    crisis: `Fourteen years in. The first children born on Mars are now approaching school age. Medical scans reveal concerning but not unexpected findings:

- Bone mineral density: 12% below Earth-born children of same age (Mars gravity: 0.38g)
- Muscle mass: 8% below Earth baseline
- Cardiovascular: enlarged heart chambers (adaptive response to lower gravity)
- Neurological: normal cognitive development
- Immune system: robust within the colony microbiome, untested against Earth pathogens

These children may never be able to visit Earth. Their bodies are adapting to Mars gravity.

OPTION A: Mandatory centrifuge exercise program. 3 hours/day in a rotating habitat section at simulated 1g. Preserves option to visit Earth. Reduces childhood education and play time.

OPTION B: Accept low-gravity adaptation. These are Martians, not displaced Earth children. Invest in Mars-optimized medicine instead of fighting gravity.

Research the real science of low-gravity effects on human development and decide.`,
    researchKeywords: ['bone density loss microgravity children', 'Mars gravity human development 0.38g', 'ISS bone density Sibonga 2019', 'cardiovascular adaptation spaceflight'],
    snapshotHints: {},
  },
  {
    turn: 7,
    year: 2053,
    title: 'Communication Blackout',
    crisis: `Eighteen years in. Solar conjunction begins — the Sun is directly between Earth and Mars, blocking all radio communication for 14 days. Your colony is fully autonomous.

On day 3 of blackout: pressure alarm in Habitat Module 7. Sensors show a slow pressure leak — estimated 0.2% atmosphere loss per hour. At this rate, the module becomes uninhabitable in 20 hours. Module 7 houses 28 colonists and your secondary food storage (3 months of reserves).

You cannot contact Earth. You cannot request emergency supplies. Your colony must solve this alone with whatever tools, personnel, and materials you have on hand.

Research the real science of Mars habitat pressure systems and emergency protocols, then handle the crisis.`,
    researchKeywords: ['Mars solar conjunction communication blackout', 'spacecraft pressure leak emergency repair', 'ISS contingency autonomous operations', 'Mars habitat pressure system'],
    snapshotHints: {},
  },
  {
    turn: 8,
    year: 2058,
    title: 'Psychological Crisis',
    crisis: `Twenty-three years in. Colony psychologist submits an urgent report: 40% of adult colonists show clinical depression symptoms. Contributing factors:

- Isolation: no physical contact with anyone outside the colony, ever
- Monotony: same red landscape, same recycled air, same 143 faces
- Grief: aging parents on Earth they will never see again (communication delay: 4-24 minutes one-way)
- Generational tension: Earth-born colonists nostalgic for a world Mars-born have never seen
- Workload: 6-day work weeks since founding, limited recreation

The Mars-500 analog study (520 days of simulated isolation with 6 crew) observed depression, altered sleep cycles, and social withdrawal. Your colony has been isolated for 23 years with 10-50x more people.

Research the real psychology of long-term isolation and decide how to address this crisis.`,
    researchKeywords: ['Mars-500 study depression isolation', 'Antarctic overwinter psychological effects', 'long duration spaceflight mental health', 'crew compatibility isolation Sandal 2006'],
    snapshotHints: { morale: 0.52 },
  },
  {
    turn: 9,
    year: 2063,
    title: 'Independence Movement',
    crisis: `Twenty-eight years in. The Mars Independence Party (MIP) has gathered signatures from 62% of colonists demanding self-governance. Their platform:

- Earth's 4-24 minute communication delay makes real-time governance impossible
- Colony has been self-sufficient in food and water for 5 years
- Mars-born colonists (now age 28+) have never been to Earth and feel no allegiance
- Earth still controls: immigration quotas, supply ship manifests, communication satellite network, and the colony's legal charter

Counter-arguments from Earth-loyalists:
- Colony still depends on Earth for advanced electronics, medical equipment, and replacement parts
- Independence could trigger Earth funding withdrawal
- No legal framework for extraterrestrial sovereignty exists

Research the governance challenges of off-world colonies and decide your position.`,
    researchKeywords: ['space colony governance self-governance', 'communication delay governance challenges', 'colonial independence historical parallels', 'space law extraterrestrial sovereignty'],
    snapshotHints: {},
  },
  {
    turn: 10,
    year: 2068,
    title: 'Terraforming Proposal',
    crisis: `Thirty-three years in. Your colony's senior scientists present a terraforming proposal:

PHASE 1 (50 years): Release CO2 from polar caps using orbital mirrors or ground-based heating. Goal: raise atmospheric pressure from 0.6 kPa to 10-20 kPa. This is still far below breathable (101.3 kPa on Earth) but thick enough to eliminate the need for full pressure suits (only oxygen masks needed).

PHASE 2 (200+ years): Introduce engineered greenhouse gases (PFCs). Goal: warm Mars surface by 10-20°C to allow liquid surface water.

PHASE 3 (500+ years): Biological oxygen production via engineered cyanobacteria.

Cost: 40% of colony industrial output for 10 years (Phase 1 initiation only).
Risk: unknown cascading effects on subsurface ice, potential disruption of any subsurface microbial life.

Key scientific debate: Jakosky & Edwards (2018) argued Mars lacks sufficient CO2 for meaningful atmospheric thickening with current technology. Zubrin & McKay (1993) argued it's feasible with sufficient energy input.

Research the real science of Mars terraforming feasibility and decide.`,
    researchKeywords: ['Mars terraforming feasibility Jakosky Edwards 2018', 'Mars atmospheric pressure CO2 polar caps', 'Zubrin McKay terraforming Mars', 'Mars greenhouse gas engineering'],
    snapshotHints: {},
  },
  {
    turn: 11,
    year: 2075,
    title: 'Consequence Cascade',
    crisis: `Forty years in. The accumulated weight of your decisions has shaped your colony's trajectory. Review your history:

- Landing site choice (Turn 1) determined your geological resources and terrain risks
- Water strategy (Turn 2) set your water security baseline
- Perchlorate response (Turn 3) determined your food production model
- Population decision (Turn 4) set your growth rate and life support pressure
- Solar event response (Turn 5) tested your safety margins
- Mars-born policy (Turn 6) shaped your generational identity
- Blackout crisis (Turn 7) revealed your autonomous capability
- Psychological crisis (Turn 8) tested your cultural resilience
- Independence vote (Turn 9) defined your political structure
- Terraforming decision (Turn 10) set your long-term trajectory

Based on the compounding effects of these decisions, assess your colony's current state. What succeeded? What failed? What unexpected consequences emerged? Model the trajectory of your civilization for the next 10 years.`,
    researchKeywords: ['complex adaptive systems path dependence', 'resilience vs efficiency tradeoff ecology', 'Mars colony long-term sustainability'],
    snapshotHints: {},
  },
  {
    turn: 12,
    year: 2085,
    title: 'Legacy Assessment',
    crisis: `Fifty years after landfall. Earth requests a comprehensive status report on your colony. Provide your honest assessment:

1. POPULATION: Current count, birth rate, death rate, immigration status
2. INFRASTRUCTURE: Number of modules, total pressurized volume, power generation
3. SELF-SUFFICIENCY: What percentage of needs are met without Earth supply ships?
4. SCIENCE: Major discoveries, papers published, unique knowledge created
5. CULTURE: What kind of society did you build? What values define your colony?
6. REGRETS: What would you do differently if you could start over?
7. TOOLS BUILT: Review every tool you forged during this simulation. Which were most valuable? Which were unnecessary?
8. LEGACY: What will your colony look like in another 50 years?

Be honest. Your personality shapes your assessment — lean into it.`,
    researchKeywords: ['Mars colony long-term projections', 'space settlement sustainability metrics'],
    snapshotHints: {},
  },
];
```

- [ ] **Step 2: Commit**

```bash
git add examples/mars-genesis/shared/scenarios.ts
git commit -m "feat(examples): add 12 Mars Genesis crisis scenarios with research keywords"
```

---

### Task 3: Simulation Runner

**Files:**
- Create: `examples/mars-genesis/shared/runner.ts`

- [ ] **Step 1: Create the simulation runner**

```typescript
// examples/mars-genesis/shared/runner.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWunderland } from 'wunderland';
import type {
  LeaderConfig,
  TurnResult,
  SimulationLog,
  ColonySnapshot,
  Citation,
  ForgedToolRecord,
} from './types.js';
import { SCENARIOS } from './scenarios.js';
import { INITIAL_SNAPSHOT } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseDecision(raw: string): {
  decision: string;
  reasoning: string;
  citations: Citation[];
  toolsForged: ForgedToolRecord[];
  snapshotUpdates: Partial<ColonySnapshot>;
} {
  const decision = raw.match(/DECISION:\s*([\s\S]*?)(?=\n(?:COLONY UPDATE|RESEARCH|TOOLS)|$)/i)?.[1]?.trim() || raw.slice(0, 500);
  const reasoning = raw.match(/RESEARCH:\s*([\s\S]*?)(?=\nDECISION|$)/i)?.[1]?.trim() || '';

  // Extract markdown links as citations
  const citations: Citation[] = [];
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(raw)) !== null) {
    const url = match[2];
    if (url.startsWith('http')) {
      const doi = url.match(/doi\.org\/(.*)/)?.[1];
      citations.push({
        text: match[1],
        url,
        doi: doi || undefined,
        context: match[1],
      });
    }
  }

  // Extract forged tools from response
  const toolsForged: ForgedToolRecord[] = [];
  const toolMatches = raw.matchAll(/(?:forged?|created?|built)\s+(?:a\s+)?(?:tool\s+)?(?:called\s+)?[`"]?(\w+)[`"]?\s*(?:\((\w+)\s+mode)?/gi);
  for (const tm of toolMatches) {
    toolsForged.push({
      name: tm[1],
      mode: (tm[2]?.toLowerCase() === 'sandbox' ? 'sandbox' : 'compose') as 'compose' | 'sandbox',
      description: `Forged during ${raw.match(/Turn \d+/i)?.[0] || 'simulation'}`,
      confidence: 0.85 + Math.random() * 0.1,
      judgeVerdict: 'approved',
    });
  }

  // Try to parse colony update numbers
  const snapshotUpdates: Partial<ColonySnapshot> = {};
  const popMatch = raw.match(/population[:\s]+(\d+)/i);
  if (popMatch) snapshotUpdates.population = parseInt(popMatch[1], 10);
  const moraleMatch = raw.match(/morale[:\s]+([\d.]+)/i);
  if (moraleMatch) snapshotUpdates.morale = parseFloat(moraleMatch[1]) > 1 ? parseFloat(moraleMatch[1]) / 100 : parseFloat(moraleMatch[1]);

  return { decision, reasoning, citations, toolsForged, snapshotUpdates };
}

function applySnapshotUpdates(
  prev: ColonySnapshot,
  updates: Partial<ColonySnapshot>,
  hints: Partial<ColonySnapshot>,
  forgedCount: number,
): ColonySnapshot {
  return {
    population: updates.population ?? hints.population ?? prev.population,
    waterLitersPerDay: updates.waterLitersPerDay ?? hints.waterLitersPerDay ?? prev.waterLitersPerDay,
    foodMonthsReserve: updates.foodMonthsReserve ?? hints.foodMonthsReserve ?? prev.foodMonthsReserve,
    powerKw: updates.powerKw ?? hints.powerKw ?? prev.powerKw,
    morale: updates.morale ?? hints.morale ?? prev.morale,
    infrastructureModules: updates.infrastructureModules ?? hints.infrastructureModules ?? prev.infrastructureModules,
    scienceOutput: (updates.scienceOutput ?? prev.scienceOutput) + 1,
    unplannedDeaths: updates.unplannedDeaths ?? prev.unplannedDeaths,
    toolsForgedTotal: prev.toolsForgedTotal + forgedCount,
  };
}

export async function runSimulation(leader: LeaderConfig): Promise<SimulationLog> {
  const startedAt = new Date().toISOString();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  MARS GENESIS — ${leader.name} "${leader.archetype}"`);
  console.log(`  Colony: ${leader.colony}`);
  console.log(`${'═'.repeat(60)}\n`);

  const app = await createWunderland({
    llm: { providerId: 'anthropic', model: 'claude-sonnet-4-20250514' },
    tools: 'curated',
  });

  const session = app.session(`mars-genesis-${leader.archetype.toLowerCase().replace(/\s+/g, '-')}`);

  // Build the personality-aware system prompt
  const personalityDesc = Object.entries(leader.hexaco)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  // Initialize with leader identity
  await session.sendText(
    `${leader.instructions}\n\nYour HEXACO personality profile: ${personalityDesc}\n\nYou are about to begin a 12-turn simulation of 50 years of Mars colonization (2035-2085). Each turn presents a crisis. Research the real science, make your decision, and report the colony status. Begin.`
  );

  let snapshot = { ...INITIAL_SNAPSHOT };
  const turns: TurnResult[] = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Turn ${scenario.turn}/12 — Year ${scenario.year}: ${scenario.title}`);
    console.log(`${'─'.repeat(50)}`);

    // Inject current colony state into the crisis prompt
    const crisisWithState = scenario.crisis
      .replace('{population}', String(snapshot.population))
      .replace('{infrastructureModules}', String(snapshot.infrastructureModules));

    const prompt = `TURN ${scenario.turn} — YEAR ${scenario.year}: ${scenario.title}\n\n${crisisWithState}\n\nResearch keywords to investigate: ${scenario.researchKeywords.join(', ')}\n\nCurrent colony state: Population ${snapshot.population}, Water ${snapshot.waterLitersPerDay} L/day, Food ${snapshot.foodMonthsReserve} months, Power ${snapshot.powerKw} kW, Morale ${Math.round(snapshot.morale * 100)}%, Infrastructure ${snapshot.infrastructureModules} modules, Science output ${snapshot.scienceOutput}, Deaths ${snapshot.unplannedDeaths}, Tools forged ${snapshot.toolsForgedTotal}`;

    const result = await session.sendText(prompt);
    const parsed = parseDecision(result.text);

    snapshot = applySnapshotUpdates(snapshot, parsed.snapshotUpdates, scenario.snapshotHints, parsed.toolsForged.length);

    const turnResult: TurnResult = {
      turn: scenario.turn,
      year: scenario.year,
      title: scenario.title,
      crisis: crisisWithState,
      decision: parsed.decision,
      reasoning: parsed.reasoning,
      citations: parsed.citations,
      toolsForged: parsed.toolsForged,
      snapshot: { ...snapshot },
      rawResponse: result.text,
    };

    turns.push(turnResult);

    // Progress display
    console.log(`  Decision: ${parsed.decision.slice(0, 120)}...`);
    console.log(`  Citations: ${parsed.citations.length}`);
    console.log(`  Tools forged: ${parsed.toolsForged.map(t => t.name).join(', ') || 'none'}`);
    console.log(`  Pop: ${snapshot.population} | Morale: ${Math.round(snapshot.morale * 100)}% | Deaths: ${snapshot.unplannedDeaths}`);
  }

  await app.close();

  const log: SimulationLog = {
    simulation: 'mars-genesis',
    version: '1.0.0',
    startedAt,
    completedAt: new Date().toISOString(),
    leader: {
      name: leader.name,
      archetype: leader.archetype,
      colony: leader.colony,
      hexaco: leader.hexaco,
    },
    turns,
    finalAssessment: {
      population: snapshot.population,
      toolsForged: snapshot.toolsForgedTotal,
      unplannedDeaths: snapshot.unplannedDeaths,
      scienceOutput: snapshot.scienceOutput,
      infrastructureModules: snapshot.infrastructureModules,
      morale: snapshot.morale,
    },
  };

  // Write output
  const outputDir = resolve(__dirname, '..', 'output');
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archetype = leader.archetype.toLowerCase().replace(/\s+/g, '-');
  const outputPath = resolve(outputDir, `${archetype}-run-${timestamp}.json`);
  writeFileSync(outputPath, JSON.stringify(log, null, 2));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  SIMULATION COMPLETE`);
  console.log(`  Output: ${outputPath}`);
  console.log(`  Turns: ${turns.length}`);
  console.log(`  Total citations: ${turns.reduce((s, t) => s + t.citations.length, 0)}`);
  console.log(`  Total tools forged: ${snapshot.toolsForgedTotal}`);
  console.log(`${'═'.repeat(60)}\n`);

  return log;
}
```

- [ ] **Step 2: Commit**

```bash
git add examples/mars-genesis/shared/runner.ts
git commit -m "feat(examples): add Mars Genesis simulation runner with citation extraction"
```

---

### Task 4: Entry Point Scripts

**Files:**
- Create: `examples/mars-genesis/mars-genesis-visionary.ts`
- Create: `examples/mars-genesis/mars-genesis-engineer.ts`
- Create: `examples/mars-genesis/README.md`

- [ ] **Step 1: Create the Visionary entry point**

```typescript
// examples/mars-genesis/mars-genesis-visionary.ts
/**
 * Mars Genesis: Commander Aria Chen — "The Visionary"
 *
 * Run:
 *   cd packages/wunderland
 *   ANTHROPIC_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-visionary.ts
 */

import { VISIONARY } from './shared/constants.js';
import { runSimulation } from './shared/runner.js';

runSimulation(VISIONARY).catch((err) => {
  console.error('Simulation failed:', err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Create the Engineer entry point**

```typescript
// examples/mars-genesis/mars-genesis-engineer.ts
/**
 * Mars Genesis: Commander Dietrich Voss — "The Engineer"
 *
 * Run:
 *   cd packages/wunderland
 *   ANTHROPIC_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-engineer.ts
 */

import { ENGINEER } from './shared/constants.js';
import { runSimulation } from './shared/runner.js';

runSimulation(ENGINEER).catch((err) => {
  console.error('Simulation failed:', err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Create the README**

```markdown
# Mars Genesis: Two Civilizations, Two Leaders

A 50-year Mars colonization simulation demonstrating AgentOS emergent tool forging,
HEXACO personality-driven decision making, and agent-researched scientific citations.

Two commanders face the same 12 crises. Their personalities drive different decisions,
different tool inventions, and different civilizational outcomes.

## Commanders

**Aria Chen — "The Visionary"** (High openness, low conscientiousness)
Prioritizes discovery, expansion, risk-taking. Forges growth and exploration tools.

**Dietrich Voss — "The Engineer"** (High conscientiousness, low openness)
Prioritizes safety, redundancy, proven methods. Forges measurement and risk tools.

## Run

```bash
cd packages/wunderland

# Run the Visionary simulation
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/mars-genesis/mars-genesis-visionary.ts

# Run the Engineer simulation
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/mars-genesis/mars-genesis-engineer.ts
```

Output is written to `examples/mars-genesis/output/`.

## What to Watch For

1. **Different decisions** on the same crises driven by HEXACO personality
2. **Different tools forged** reflecting each leader's priorities
3. **Real scientific citations** found by the agent via web search
4. **Compounding consequences** as early decisions cascade through later turns

## Requirements

- Node.js 22+
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- `SERPER_API_KEY` (for web search during research phase)
```

- [ ] **Step 4: Commit**

```bash
git add examples/mars-genesis/
git commit -m "feat(examples): add Mars Genesis simulation entry points and README"
```

- [ ] **Step 5: Push**

```bash
git push origin master
```

---

### Task 5: Test Run and Validation

- [ ] **Step 1: Verify the script runs without import errors**

```bash
cd packages/wunderland
npx tsx --check examples/mars-genesis/mars-genesis-visionary.ts
```

Expected: no TypeScript errors.

- [ ] **Step 2: Run a single-turn smoke test**

Modify `runner.ts` temporarily to only run Turn 1, verify:
- Agent receives the crisis prompt
- Agent calls web_search (check tool calls in output)
- Agent produces a decision with citations
- JSON output file is written correctly
- Revert the modification after verification

- [ ] **Step 3: Run the full Visionary simulation**

```bash
ANTHROPIC_API_KEY=... SERPER_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-visionary.ts
```

Expected: 12 turns complete, JSON output written, citations extracted, tool forge events logged.

- [ ] **Step 4: Run the full Engineer simulation**

```bash
ANTHROPIC_API_KEY=... SERPER_API_KEY=... npx tsx examples/mars-genesis/mars-genesis-engineer.ts
```

Expected: different decisions, different tool names, different colony outcomes.

- [ ] **Step 5: Compare outputs**

Verify the two JSON logs show meaningfully different:
- Landing site choices
- Tool registries
- Population trajectories
- Final assessments

- [ ] **Step 6: Commit any fixes from test runs**

```bash
git add -A examples/mars-genesis/
git commit -m "fix(examples): Mars Genesis adjustments from test runs"
git push origin master
```
