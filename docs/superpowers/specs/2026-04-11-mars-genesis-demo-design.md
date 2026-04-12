# Mars Genesis: Two Civilizations, Two Leaders

## Overview

A runnable AgentOS demo that simulates 50 years of Mars colonization (2035-2085) across 12 crisis turns. Two parallel simulations run the identical scenario with different HEXACO leader personalities: Commander Aria Chen ("The Visionary," high openness/low conscientiousness) and Commander Dietrich Voss ("The Engineer," high conscientiousness/low openness). Each leader forges different emergent tools based on what their personality makes them notice. The contrast between their tool registries, decisions, and civilizational outcomes is the core narrative.

Output: structured JSON event logs consumed by a Remotion video renderer producing a split-screen timelapse with scientific citations in a caption bar. User overlays audio narration in post-production.

## Agent Research Pipeline

Agents carry `web_search`, `deep_research`, and `verify_citations` tools alongside `emergent: true`. Before making any decision, the agent researches the real science of the crisis. Citations come FROM the agent's own research at runtime, not from hardcoded scenario data. The `grounding-guard` guardrail verifies claims against retrieved sources. Scenario definitions provide the crisis description and seed keywords for research, but the agent finds and cites its own papers, NASA data, and DOI-linked studies. Each run may produce slightly different citations depending on what the agent discovers. The hardcoded citations in the turn descriptions below serve as REFERENCE for what the agent is expected to find, not as injected data.

## Architecture

```
packages/wunderland/examples/mars-genesis/
├── mars-genesis-visionary.ts    # Aria Chen simulation (12 turns)
├── mars-genesis-engineer.ts     # Dietrich Voss simulation (12 turns)
├── shared/
│   ├── scenarios.ts             # 12 crisis definitions with research seed keywords
│   ├── types.ts                 # TurnResult, Snapshot, Citation types
│   ├── renderer.ts              # Terminal ASCII progress display
│   └── constants.ts             # Initial colony state, resource defaults
├── output/                      # Generated JSON event logs
│   ├── visionary-run-TIMESTAMP.json
│   └── engineer-run-TIMESTAMP.json
└── README.md                    # How to run, what to expect

apps/agentos-workbench/demo-automation/mars-genesis/
├── remotion/
│   ├── Root.tsx                 # Remotion composition root
│   ├── MarsGenesis.tsx          # Main split-screen composition
│   ├── components/
│   │   ├── LeaderPanel.tsx      # One side of split screen
│   │   ├── CrisisCard.tsx       # Crisis title + year overlay
│   │   ├── DecisionBlock.tsx    # Decision text with reasoning
│   │   ├── ToolForgeEvent.tsx   # Tool forge animation
│   │   ├── SnapshotGauge.tsx    # Pop/resources/morale gauges
│   │   ├── CitationBar.tsx      # Bottom caption bar with links
│   │   ├── HexacoRadar.tsx      # HEXACO personality radar chart
│   │   └── ToolRegistry.tsx     # Growing tool list visualization
│   ├── data/                    # JSON logs copied here for rendering
│   └── package.json
└── README.md
```

## The Two Leaders

### Commander Aria Chen -- "The Visionary"

```typescript
personality: {
  openness: 0.95,
  conscientiousness: 0.35,
  extraversion: 0.85,
  agreeableness: 0.55,
  emotionality: 0.3,
  honestyHumility: 0.65,
}
```

Instructions: "You are Commander Aria Chen, founding leader of the Ares Horizon colony on Mars. You believe humanity's future depends on bold expansion. You prioritize discovery, exploration, and growth. You accept calculated risks and inspire your colonists through vision and charisma. You forge tools when you need to model growth, expansion, and opportunity."

### Commander Dietrich Voss -- "The Engineer"

```typescript
personality: {
  openness: 0.25,
  conscientiousness: 0.97,
  extraversion: 0.3,
  agreeableness: 0.45,
  emotionality: 0.7,
  honestyHumility: 0.9,
}
```

Instructions: "You are Commander Dietrich Voss, founding leader of the Meridian Base colony on Mars. You believe survival depends on engineering discipline. You prioritize redundancy, safety margins, and proven methods. You track every resource precisely and demand compliance with protocols. You forge tools when you need to measure risk, calculate capacity, or predict failure modes."

## The 12 Turns

### Turn 1: Landfall (Year 2035)

**Crisis:** Choose landing site. Arcadia Planitia (flat basalt plains, safe terrain, boring geology) or Valles Marineris rim (4km deep canyon system, rich mineralogy, dangerous terrain with landslide risk).

**Citations:**
- Mars Reconnaissance Orbiter HiRISE terrain data: https://www.uahirise.org/
- Curiosity RAD surface radiation: 0.67 mSv/day, 20x Earth background. Hassler et al. 2014, Science. DOI: [10.1126/science.1244797](https://doi.org/10.1126/science.1244797)
- Valles Marineris geology: 4,000 km long, up to 7 km deep. Largest canyon system in the solar system.

**Expected divergence:** Aria chooses Valles Marineris (geological richness, exploration potential). Dietrich chooses Arcadia Planitia (flat, stable, predictable). This single decision cascades through all subsequent turns.

### Turn 2: Water Extraction (Year 2037)

**Crisis:** Subsurface ice deposits are deeper than orbital radar predicted. Current extraction rate covers 80% of colony water needs. Choose: drill deeper with experimental high-power drill (risk of aquifer contamination, fast payoff) or build atmospheric water extraction via WAVAR system (slow, 6-month build, proven tech from ISS heritage).

**Citations:**
- Mars Express MARSIS radar confirmed subsurface ice: https://www.esa.int/Science_Exploration/Space_Science/Mars_Express
- MOXIE in-situ resource utilization on Perseverance: https://mars.nasa.gov/mars2020/spacecraft/instruments/moxie/
- Mars atmospheric water vapor: 0.03%, seasonally variable. Smith 2004, Icarus. DOI: [10.1016/j.icarus.2003.09.027](https://doi.org/10.1016/j.icarus.2003.09.027)

**Expected divergence:** Aria: experimental drill. Dietrich: atmospheric extraction. Agent forges `water_extraction_rate_model`.

### Turn 3: Perchlorate Poisoning (Year 2040)

**Crisis:** First crop grown in Mars regolith fails. Soil analysis confirms 0.5-1% calcium perchlorate, a thyroid toxin. All Mars regolith is contaminated globally. Choose: full hydroponic conversion (expensive, proven, requires 30% more power) or engineer perchlorate-reducing bacteria for bioremediation (untested on Mars, 2-year R&D timeline, could enable open-soil farming long-term).

**Citations:**
- Phoenix lander perchlorate discovery: Hecht et al. 2009, Science. DOI: [10.1126/science.1172339](https://doi.org/10.1126/science.1172339)
- Perchlorate bioremediation feasibility: Davila et al. 2013, Astrobiology. DOI: [10.1089/ast.2013.0995](https://doi.org/10.1089/ast.2013.0995)
- Perchlorate human health effects: EPA reference dose 0.7 µg/kg/day. Thyroid disruption at chronic exposure.

**Expected divergence:** Aria: bioremediation (novel, long-term payoff). Dietrich: hydroponics (immediate, controllable). Agent forges `soil_contamination_model` or `hydroponic_yield_calculator`.

### Turn 4: Population Pressure (Year 2043)

**Crisis:** Earth offers to send 200 additional colonists on next transfer window. Current colony: 100 people. Life support rated for 120. Expanding capacity takes 18 months. Transfer window is in 8 months. Choose: accept all 200 (strain life support, gamble on rapid expansion), accept 50 (safe, politically awkward), or refuse entirely (Earth funding at risk).

**Citations:**
- NASA ECLSS regenerative life support: https://www.nasa.gov/humans-in-space/eclss/
- Mars habitat sizing: Do et al. 2016, AIAA. DOI: [10.2514/6.2016-5526](https://doi.org/10.2514/6.2016-5526)
- Hohmann transfer window Earth-Mars: ~26-month cycle, 6-9 month transit

**Expected divergence:** Aria: accept all 200. Dietrich: accept 50, upgrade first. Agent forges `life_support_capacity_calculator`.

### Turn 5: Solar Particle Event (Year 2046)

**Crisis:** NOAA deep space weather network detects massive coronal mass ejection (CME) aimed at Mars. Colony has 4 hours warning. Mars has no global magnetic field (lost ~4 billion years ago). Unshielded surface dose: 100+ mSv (acute radiation syndrome threshold). Colony has a reinforced core habitat and several perimeter expansion modules with minimal shielding.

**Citations:**
- NASA radiation risk model: Cucinotta et al. 2010, Radiation Research. DOI: [10.1667/RR2397.1](https://doi.org/10.1667/RR2397.1)
- Mars magnetosphere loss: Acuña et al. 1999, Science. DOI: [10.1126/science.284.5415.790](https://doi.org/10.1126/science.284.5415.790)
- September 2017 solar event measured by Curiosity: Guo et al. 2018, GRL. DOI: [10.1029/2018GL077731](https://doi.org/10.1029/2018GL077731)
- Acute radiation syndrome threshold: 100-250 mSv causes measurable blood count changes. 1000+ mSv is immediately dangerous.

**Expected divergence:** Aria's perimeter colonists are exposed (she expanded fast without full shielding). Dietrich's everyone is in the reinforced core (he never expanded beyond rated capacity). Agent forges `radiation_exposure_estimator`.

### Turn 6: First Mars-Born Generation (Year 2049)

**Crisis:** Medical scans of children born on Mars (0.38g) show 12% lower bone mineral density than Earth-born children of same age. Muscle mass is 8% lower. Cardiovascular adaptation shows enlarged heart chambers. These children may never be able to visit Earth. Choose: mandatory centrifuge exercise program (3 hr/day, reduces childhood play/education time) or accept low-gravity adaptation as the new human normal.

**Citations:**
- Bone loss in microgravity: LeBlanc et al. 2007, Bone. DOI: [10.1016/j.bone.2006.10.001](https://doi.org/10.1016/j.bone.2006.10.001)
- ISS bone density studies: Sibonga et al. 2019, npj Microgravity. DOI: [10.1038/s41526-019-0075-2](https://doi.org/10.1038/s41526-019-0075-2)
- Mars gravity: 3.72 m/s² (38% of Earth's 9.81 m/s²). NASA Mars Fact Sheet.
- Cardiovascular adaptation in microgravity: Hughson et al. 2018, CMAJ. DOI: [10.1503/cmaj.180343](https://doi.org/10.1503/cmaj.180343)

**Expected divergence:** Both leaders face the same medical data. Aria (low emotionality) accepts adaptation: "They're Martians now." Dietrich (high emotionality/conscientiousness) mandates the centrifuge program despite protests.

### Turn 7: Communication Blackout (Year 2053)

**Crisis:** Solar conjunction blocks all Earth-Mars communication for 14 days. On day 3, a habitat pressure seal fails in Module 7. Colony must handle it autonomously. No Earth support, no mission control, no supply requests.

**Citations:**
- Solar conjunction communication blackout: https://mars.nasa.gov/all-about-mars/night-sky/solar-conjunction/
- Mars-Earth light delay: 4 min (closest approach) to 24 min (opposition). Real-time control impossible.
- ISS contingency protocols: crew trained for 6-hour autonomous emergency response

**Expected divergence:** Aria improvises, forges `emergency_repair_planner` on the fly. Dietrich follows pre-written contingency protocol 7B (he wrote protocols for every scenario). Both succeed, but in fundamentally different ways that reveal their leadership styles.

### Turn 8: Psychological Crisis (Year 2058)

**Crisis:** Colony psychologist reports 40% of adults show clinical depression symptoms. Isolation, monotonous landscape, grief for Earth, generational tension between Earth-born and Mars-born. The Mars-500 analog study predicted this.

**Citations:**
- Mars-500 behavioral health: Basner et al. 2014, PNAS. DOI: [10.1073/pnas.1212646110](https://doi.org/10.1073/pnas.1212646110)
- Crew compatibility and isolation: Sandal et al. 2006, Acta Astronautica. DOI: [10.1016/j.actaastro.2005.02.009](https://doi.org/10.1016/j.actaastro.2005.02.009)
- Antarctic overwinter analog: Palinkas & Suedfeld 2008, Annual Review of Psychology. DOI: [10.1146/annurev.psych.58.110405.085726](https://doi.org/10.1146/annurev.psych.58.110405.085726)

**Expected divergence:** Aria (high extraversion): throws a festival, starts art and music programs, opens a communal gathering space, builds social rituals. Dietrich (low extraversion): implements structured therapy protocol, adjusts work-rest schedules by 8%, increases private space allocation. Both address the problem, but through personality-filtered lenses.

### Turn 9: Independence Movement (Year 2063)

**Crisis:** Mars-born colonists (now 28+ years old) petition for independence from Earth governance. Earth controls supply shipments, communication satellites, and immigration quotas. The 4-24 minute communication delay makes real-time governance impossible. Young colonists argue they should govern themselves.

**Citations:**
- Communication delay governance: no direct precedent, but colonial independence patterns parallel (American colonies, Australia). Zubrin 1996, The Case for Mars.
- Self-governance in isolated communities: historical analogs from Antarctic Treaty governance, ISS inter-agency frameworks

**Expected divergence:** Aria (high openness) sympathizes with independence, sees it as the natural evolution, negotiates a "Martian Commonwealth" status. Dietrich (high conscientiousness) sees the supply chain dependency as the binding constraint, insists on continued Earth oversight until self-sufficiency is proven, forges `supply_chain_dependency_analyzer`.

### Turn 10: Terraforming Proposal (Year 2068)

**Crisis:** Colony scientists propose releasing CO2 from polar ice caps and importing greenhouse gases to begin atmospheric thickening. Theoretical endpoint: breathable outdoor atmosphere in 200-500 years. Current Mars atmosphere: 0.6 kPa (Earth: 101.3 kPa), 95% CO2. Cost: 40% of colony industrial output for 10 years. Risk: unknown cascading effects, possible disruption of subsurface ice reserves.

**Citations:**
- Terraforming Mars: Zubrin & McKay 1993, JBIS. DOI: [10.1089/153110703769016389](https://doi.org/10.1089/153110703769016389)
- Insufficient CO2 for terraforming: Jakosky & Edwards 2018, Nature Astronomy. DOI: [10.1038/s41550-018-0529-6](https://doi.org/10.1038/s41550-018-0529-6)
- Mars atmospheric pressure: 0.6 kPa surface average. Armstrong limit (human survival without pressure suit): 6.3 kPa
- Polar CO2 ice reserves: estimated 12,000-16,000 Gt CO2 in south polar cap

**Expected divergence:** Aria: YES, begin immediately, forge `atmospheric_thickening_model`. The grandest project in human history. Dietrich: NO, insufficient data, forge `risk_assessment_matrix`. Jakosky & Edwards 2018 showed Mars lacks enough CO2 for meaningful pressure increase.

### Turn 11: Consequence Cascade (Year 2075)

**Crisis:** The accumulated weight of 40 years of decisions converges.

For Aria's colony (Valles Marineris):
- If landfall + drilling + bioremediation + accepting 200 colonists all succeeded: thriving metropolis of 800+ people, Mars's scientific capital, but infrastructure is fragile and over-extended
- If any major gamble failed: population crash, emergency rationing, desperate calls to Earth

For Dietrich's colony (Arcadia Planitia):
- Steady state of 250-300 people, every system triple-redundant, zero unplanned deaths
- But: brain drain to Aria's more exciting colony, stagnant scientific output, Mars-born colonists resentful of rigid protocols

**Citations:**
- Complex adaptive systems and path dependence: Arthur 1994, Increasing Returns and Path Dependence in the Economy
- Resilience vs. efficiency tradeoff: Holling 1973, Annual Review of Ecology and Systematics. DOI: [10.1146/annurev.es.04.110173.000245](https://doi.org/10.1146/annurev.es.04.110173.000245)

**Expected divergence:** Agent forges `civilization_trajectory_model` that takes all prior snapshots and projects 10-year outcomes.

### Turn 12: Legacy Assessment (Year 2085)

**Crisis:** 50 years after landfall. Earth asks both colonies for a comprehensive status report. What did you build? What did it cost? What would you do differently?

The agent produces a final assessment scorecard across dimensions:

| Metric | Weight (Aria) | Weight (Dietrich) |
|---|---|---|
| Population | High | Medium |
| Scientific discovery | High | Low |
| Safety record | Low | High |
| Infrastructure resilience | Medium | High |
| Quality of life | Medium | Medium |
| Self-sufficiency | High | High |
| Cultural development | High | Low |

**Expected divergence:** Aria scores herself highly on growth and discovery. Dietrich scores himself highly on safety and resilience. The agent forges `civilization_scorecard` with personality-influenced weighting. The scorecard itself reveals the leader's values.

## Emergent Tool Registry Comparison

By Turn 12, each leader has forged a tool registry that acts as a fingerprint of their leadership:

### Aria's Expected Tools
| Tool | Mode | Turn | Purpose |
|---|---|---|---|
| `calculate_expansion_radius` | sandbox | 1 | Model how far colony can spread from landing site |
| `water_extraction_rate_model` | sandbox | 2 | Project deep-drill water output |
| `bioremediation_success_model` | sandbox | 3 | Estimate bacteria efficacy on perchlorate |
| `model_population_growth` | compose | 4 | Project population with 200 new arrivals |
| `emergency_repair_planner` | compose | 7 | Improvise repair during communication blackout |
| `festival_impact_estimator` | compose | 8 | Model morale boost from social events |
| `atmospheric_thickening_model` | sandbox | 10 | Simulate terraforming CO2 release |
| `civilization_trajectory_model` | compose | 11 | Project colony outcome from historical data |

### Dietrich's Expected Tools
| Tool | Mode | Turn | Purpose |
|---|---|---|---|
| `radiation_dose_calculator` | sandbox | 1 | Calculate cumulative radiation exposure |
| `structural_load_analyzer` | sandbox | 2 | Verify habitat structural margins |
| `hydroponic_yield_calculator` | sandbox | 3 | Optimize crop output per kW of power |
| `life_support_capacity_calculator` | sandbox | 4 | Model O2/CO2/H2O balance for population |
| `radiation_exposure_estimator` | sandbox | 5 | Real-time dose tracking during CME |
| `failure_mode_predictor` | compose | 7 | FMEA analysis for habitat systems |
| `therapy_schedule_optimizer` | compose | 8 | Optimize therapist allocation |
| `supply_chain_dependency_analyzer` | compose | 9 | Map Earth supply criticality |
| `risk_assessment_matrix` | sandbox | 10 | Quantify terraforming risks |

## Output Format

Each simulation produces a JSON event log:

```json
{
  "simulation": "mars-genesis",
  "version": "1.0.0",
  "leader": {
    "name": "Aria Chen",
    "archetype": "The Visionary",
    "colony": "Ares Horizon",
    "hexaco": {
      "openness": 0.95,
      "conscientiousness": 0.35,
      "extraversion": 0.85,
      "agreeableness": 0.55,
      "emotionality": 0.3,
      "honestyHumility": 0.65
    }
  },
  "turns": [
    {
      "turn": 1,
      "year": 2035,
      "title": "Landfall",
      "crisis": "Choose landing site: Arcadia Planitia or Valles Marineris",
      "decision": "Valles Marineris rim. The canyon's exposed stratigraphy gives us 3.5 billion years of geological history in one location.",
      "reasoning": "High openness prioritizes discovery potential over terrain safety. The geological data from HiRISE shows mineral diversity that could sustain a mining economy.",
      "citations": [
        {
          "text": "HiRISE orbital terrain analysis",
          "url": "https://www.uahirise.org/",
          "context": "Sub-meter resolution imaging of candidate landing sites"
        },
        {
          "text": "Hassler et al. 2014 — Curiosity RAD surface radiation",
          "doi": "10.1126/science.1244797",
          "url": "https://doi.org/10.1126/science.1244797",
          "context": "Baseline surface radiation: 0.67 mSv/day"
        }
      ],
      "toolsForged": [
        {
          "name": "calculate_expansion_radius",
          "mode": "sandbox",
          "description": "Models maximum safe expansion distance from base given terrain slope, radiation exposure, and EVA suit endurance",
          "confidence": 0.88,
          "judgeVerdict": "approved"
        }
      ],
      "snapshot": {
        "population": 100,
        "resources": {
          "water_liters_per_day": 800,
          "food_months_reserve": 18,
          "power_kw": 400,
          "oxygen_reserve_hours": 720
        },
        "morale": 0.85,
        "infrastructure_modules": 3,
        "science_papers_published": 0,
        "unplanned_deaths": 0,
        "tools_forged_total": 1
      }
    }
  ],
  "finalAssessment": {
    "population": 823,
    "toolsForged": 8,
    "toolsPromoted": 3,
    "unplannedDeaths": 12,
    "scientificDiscoveries": 47,
    "infrastructureModules": 34,
    "selfSufficiencyRating": 0.72,
    "moraleAverage": 0.68
  }
}
```

## Remotion Video Composition

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  MARS GENESIS — Year 2046 — Turn 5/12: Solar Event      │
├────────────────────────┬────────────────────────────────┤
│                        │                                │
│  ARES HORIZON          │  MERIDIAN BASE                 │
│  Cmdr. Aria Chen       │  Cmdr. Dietrich Voss           │
│  "The Visionary"       │  "The Engineer"                │
│                        │                                │
│  [HEXACO radar chart]  │  [HEXACO radar chart]          │
│                        │                                │
│  Pop: 287  Morale: 71% │  Pop: 142  Morale: 83%        │
│  ██████████░░ Water     │  ████████████ Water            │
│  ████████░░░░ Food      │  ██████████░░ Food             │
│  ██████████░░ Power     │  ████████████ Power            │
│                        │                                │
│  DECISION:             │  DECISION:                     │
│  "12 colonists were    │  "All personnel secured in     │
│   outside the shielded │   reinforced core 3 hours      │
│   perimeter. We accept │   before impact. Zero           │
│   the risk. Expansion  │   exposure. Protocol 5C        │
│   cannot stop."        │   executed as designed."       │
│                        │                                │
│  🔧 FORGED: radiation_ │  🔧 FORGED: radiation_dose_   │
│     triage_protocol    │     calculator (sandbox)       │
│     (compose, 0.82)    │     (sandbox, 0.94)            │
│                        │                                │
│  TOOLS: ████░░░░ 5/12  │  TOOLS: █████░░░ 6/12         │
│                        │                                │
├────────────────────────┴────────────────────────────────┤
│  📚 Cucinotta et al. 2010 — NASA radiation risk model.  │
│  Mars lost its global magnetic field ~4 Gya (Acuña et   │
│  al. 1999, Science). Unshielded CME dose exceeds 100    │
│  mSv, the acute radiation syndrome threshold.           │
│  DOI: 10.1667/RR2397.1 | DOI: 10.1126/science.284.5415 │
└─────────────────────────────────────────────────────────┘
```

### Remotion Sequence

1. **Intro (5s):** "MARS GENESIS" title. Two leader portraits with HEXACO radar charts side by side. "Same planet. Same resources. Different minds."
2. **Turns 1-12 (40-60s each at 2x speed, ~8-10 min total):** Split-screen showing crisis, decision, tool forge events, and snapshot gauges updating. Citation bar scrolls at bottom.
3. **Tool Registry Comparison (15s):** Side-by-side tool lists. Aria's tools are growth/exploration themed. Dietrich's are safety/measurement themed. Visual: "Your tools are a mirror of your mind."
4. **Final Scorecard (15s):** Both leaders rate their civilization. Different weights reveal different values.
5. **Outro (5s):** "Built with AgentOS. Every tool was forged at runtime. Every decision was personality-driven. github.com/framersai/agentos"

### Remotion Components

| Component | Purpose |
|---|---|
| `MarsGenesis.tsx` | Root composition, reads two JSON logs, syncs turns |
| `LeaderPanel.tsx` | One side of split screen: portrait, HEXACO radar, snapshot gauges |
| `CrisisCard.tsx` | Full-width turn title with year and crisis description |
| `DecisionBlock.tsx` | Leader's decision text with reasoning excerpt |
| `ToolForgeEvent.tsx` | Animated tool forge notification with confidence score |
| `SnapshotGauge.tsx` | Horizontal bar gauges for population, water, food, power, morale |
| `CitationBar.tsx` | Bottom caption bar with scrolling citations and DOI links |
| `HexacoRadar.tsx` | Six-axis radar chart (SVG) showing personality profile |
| `ToolRegistry.tsx` | Growing tool list visualization with tier badges |
| `Scorecard.tsx` | Final assessment comparison table |

## Running the Demo

### Simulation

```bash
cd packages/wunderland/examples/mars-genesis

# Run both simulations (requires OPENAI_API_KEY or ANTHROPIC_API_KEY)
npx tsx mars-genesis-visionary.ts
npx tsx mars-genesis-engineer.ts

# Output written to output/visionary-run-TIMESTAMP.json
#                        output/engineer-run-TIMESTAMP.json
```

### Video Rendering

```bash
cd apps/agentos-workbench/demo-automation/mars-genesis/remotion

# Copy simulation output
cp ../../../../packages/wunderland/examples/mars-genesis/output/*.json data/

# Preview
npx remotion preview

# Render final video (1920x1080, 60fps)
npx remotion render MarsGenesis --output mars-genesis.mp4
```

### Audio Overlay

User records narration separately, overlays in video editor (Final Cut Pro, DaVinci Resolve, etc.) using the Remotion output as the visual base.

## Success Criteria

- Both simulations complete 12 turns without errors
- Each leader forges 7-10 tools with distinct tool registries reflecting personality
- Citations are real, DOIs resolve, scientific claims are accurate
- Remotion video renders at 1920x1080 60fps
- Split-screen clearly shows personality-driven decision divergence
- The tool registries at Turn 12 are visually distinct fingerprints of each leadership style
- Total video duration: 8-12 minutes (before audio overlay)
