# Wunderland CLI v0.27.0 — Full Command Reference

Generated: 2026-02-22

**Updated in v0.27.0:** Grouped help output, `wunderland help <topic>` onboarding guides, TUI command-palette search (`/`), and in-TUI help/details modals (`?` / `⏎`).

---

## `wunderland --help`

```
  Usage:
    wunderland                        Open TUI dashboard (TTY only)
    wunderland <command> [options]
    wunderland help <topic>           Short guides + onboarding

  Quickstart:
    wunderland setup                  Interactive onboarding wizard
    wunderland doctor                 Health check: keys, tools, connectivity
    wunderland chat                   Interactive terminal assistant
    wunderland start                  Start local agent server

  Commands (grouped):
    Onboarding
      setup                 Wizard: keys, channels, personality
      init <dir>            Scaffold an agent project
      create [description]  Create agent from natural language
      doctor                Health check

    Run
      chat                  Interactive assistant (REPL)
      start                 Start server
      status                Agent & connection status
      hitl                  Watch/resolve approvals & checkpoints

    Configure
      channels              List/add/remove channels
      models                Provider/model settings
      voice                 Voice provider status
      cron                  Scheduled jobs management
      skills                Skills management
      extensions            Extension management
      list-presets          List personality & agent presets
      config                Read/write config values

    Advanced
      rag                   RAG memory management
      agency                Multi-agent collectives
      workflows             Workflow engine
      evaluate              Evaluation suite
      knowledge             Knowledge graph
      provenance            Audit trail & provenance
      marketplace           Marketplace search/install

    Utilities
      seal                  Seal agent config (integrity hash)
      verify-seal           Verify sealed.json integrity/signature
      export                Export agent as shareable manifest
      import <manifest>     Import agent from manifest file
      plugins               List installed extension packs
      export-session        Export chat session to file
      ollama-setup          Configure Ollama (local LLM)
      version               Show version

  Global Options:
    --help, -h             Show help
    --version, -v          Show version
    --quiet, -q            Suppress banner
    --yes, -y              Auto-confirm prompts (non-interactive where possible)
    --auto-approve-tools   Auto-approve tool calls (fully autonomous)
    --theme <plain|cyberpunk> UI theme (default: plain)
    --ascii                Force ASCII-only UI (auto-fallback in limited terminals)
    --no-color             Disable colors (also: NO_COLOR env)
    --dry-run              Preview without writing
    --tui                  Force interactive TUI mode
    --no-tui               Force print-and-exit (skip TUI)
    --config <path>        Config directory path

  Command Options:
    --port <number>        Server port (default: PORT env or 3777)
    --model <id>           LLM model override
    --preset <name>        Personality preset for init
    --security-tier <tier> Security tier (dangerous/permissive/balanced/strict/paranoid)
    --dir <path>           Working directory (seal)
    --format <json|table>  Output format (list-presets, skills, models, plugins)
    --lazy-tools           Start with only schema-on-demand meta tools
    --force                Overwrite existing files
    --skills-dir <path>    Load skills from directory
    --no-skills            Disable skill loading
    --export-png <path>    Export command output as styled PNG screenshot
    --dangerously-skip-permissions  Skip permission/approval checks (dangerous)
    --dangerously-skip-command-safety  Disable shell command safety checks

  Guides:
    wunderland help                   List help topics
    wunderland help <topic>           Open a short guide

  Links:
    https://wunderland.sh  ·  https://rabbithole.inc  ·  https://docs.wunderland.sh
```

---

## `wunderland version`

```
wunderland v0.27.0
```

---

## `wunderland config`

```
  WUNDERLAND v0.27.0

  ◆ Configuration
    File                     /Users/johnn/.wunderland/config.json

  ○ No configuration set. Run wunderland setup to get started.
```

---

## `wunderland doctor`

*Upgraded in v0.27.0: animated step-by-step progress with spinners (in TTY)*

```
  WUNDERLAND v0.27.0

  ◆ Wunderland Doctor

  ◇ Configuration
  ○ Config: config.json  not created yet (run wunderland setup)
  ✓ Config: .env
  ○ Config: agent.config.json  not in current directory

  ◇ API Keys
  ✓ Key: OPENAI_API_KEY  set (••••••••8M8A)
  ✓ Key: ANTHROPIC_API_KEY  set (••••••••wwAA)
  ✓ Key: OPENROUTER_API_KEY  set (••••••••a12c)
  ✓ Key: ELEVENLABS_API_KEY  set (••••••••55df)

  ◇ Channels
  ✓ Channel: telegram  configured
  ✓ Channel: discord  configured
  ✓ Channel: slack  partially configured
  ○ Channel: whatsapp  not configured
  ○ Channel: signal  not configured
  ○ Channel: imessage  not configured

  ◇ Connectivity
  ✓ Connectivity: OpenAI API  reachable (115ms)
  ✓ Connectivity: https://wunderland.sh  reachable (108ms)

  ◆ 10 passed, 5 skipped
```

---

## `wunderland status`

*Upgraded in v0.27.0: bordered panel cards per section (boxen)*

```
  WUNDERLAND v0.27.0

  ◆ Wunderland Status

  ╭  Agent  ─────────────────────────────────────────────────────────────────╮
  │ Project              no agent.config.json in current directory           │
  ╰──────────────────────────────────────────────────────────────────────────╯

  ╭  LLM Keys  ──────────────────────────────────────────────────────────────╮
  │ ✓ OPENAI_API_KEY           ••••••••8M8A                                  │
  │ ✓ OPENROUTER_API_KEY       ••••••••a12c                                  │
  │ ✓ ANTHROPIC_API_KEY        ••••••••wwAA                                  │
  ╰──────────────────────────────────────────────────────────────────────────╯

  ╭  Channels  ──────────────────────────────────────────────────────────────╮
  │ ○ No channels configured                                                 │
  ╰──────────────────────────────────────────────────────────────────────────╯

  ╭  Tool Keys  ─────────────────────────────────────────────────────────────╮
  │ ✓ SERPER_API_KEY           ••••••••9b8f                                  │
  │ ○ SERPAPI_API_KEY          not set                                       │
  │ ○ BRAVE_API_KEY            not set                                       │
  │ ✓ NEWSAPI_API_KEY          ••••••••a145                                  │
  │ ✓ GIPHY_API_KEY            ••••••••wu61                                  │
  │ ✓ PEXELS_API_KEY           ••••••••cI3V                                  │
  │ ✓ UNSPLASH_ACCESS_KEY      ••••••••Ezf0                                  │
  │ ✓ ELEVENLABS_API_KEY       ••••••••55df                                  │
  ╰──────────────────────────────────────────────────────────────────────────╯

  ╭  Token Usage  ───────────────────────────────────────────────────────────╮
  │ ○ No token usage recorded this session                                   │
  │ Token tracking activates when chat or start commands make LLM calls      │
  ╰──────────────────────────────────────────────────────────────────────────╯
```

---

## `wunderland list-presets`

*Upgraded in v0.27.0: styled tables with cli-table3*

```
  WUNDERLAND v0.27.0

  ◆ Agent Presets

       ID                        Name                      Security        Skills
       ──────────────────────    ──────────────────────    ────────────    ────────────────────────
       code-reviewer             Code Reviewer             strict          coding-agent, github
       creative-writer           Creative Writer           balanced        summarize, image-gen
       customer-support          Customer Support Agent    strict          healthcheck
       data-analyst              Data Analyst              balanced        summarize, coding-agent
       devops-assistant          DevOps Assistant          strict          healthcheck, coding-agent,
                                                                           github
       personal-assistant        Personal Assistant        balanced        weather, apple-notes,
                                                                           apple-reminders, summarize
       research-assistant        Research Assistant        balanced        web-search, summarize,
                                                                           github
       security-auditor          Security Auditor          paranoid        coding-agent, github,
                                                                           healthcheck

  ◆ Personality Presets

       ID                            Label                       Description
       ──────────────────────────    ────────────────────────    ──────────────────────────────────
       HELPFUL_ASSISTANT             Helpful Assistant           Organized, detail-oriented,
                                                                 accommodating
       CREATIVE_THINKER              Creative Thinker            Imaginative, unconventional, open
       ANALYTICAL_RESEARCHER         Analytical Researcher       Precise, systematic, thorough
       EMPATHETIC_COUNSELOR          Empathetic Counselor        Warm, supportive, patient
       DECISIVE_EXECUTOR             Decisive Executor           Direct, confident, results-driven

  ◆ HEXACO Trait Presets

       ID                                 H         E         X         A         C         O
       ──────────────────────────    ──────    ──────    ──────    ──────    ──────    ──────
       HELPFUL_ASSISTANT                0.8       0.5       0.6       0.8       0.8       0.7
       CREATIVE_THINKER                 0.7       0.6       0.7       0.6       0.5       0.9
       ANALYTICAL_RESEARCHER            0.9       0.3       0.4       0.6       0.9       0.8
       EMPATHETIC_COUNSELOR             0.8       0.8       0.6       0.9       0.7       0.7
       DECISIVE_EXECUTOR                0.6       0.3       0.8       0.5       0.8       0.6

  ◇ Use with: wunderland init my-agent --preset research-assistant
```

---

## `wunderland models`

*Upgraded in v0.27.0: tabular grid with status badges*

```
  WUNDERLAND v0.27.0

  ◆ LLM Providers & Models

             Provider              Label                 Key Status        Models
       ──    ──────────────────    ──────────────────    ──────────────    ────────────────────────
       ✓     openai                OpenAI                configured        gpt-4o-mini, gpt-4o,
                                                                           gpt-4.1-mini, gpt-4.1,
                                                                           o4-mini
       ✓     anthropic             Anthropic             configured        claude-sonnet-4-5-20250…
                                                                           claude-haiku-4-5-202510…
                                                                           claude-opus-4-6
       ✓     openrouter            OpenRouter            configured        auto
       ✓     ollama                Ollama (local)        no key            llama3, llama3.2:3b,
                                                                           mistral, codellama
       ○     bedrock               AWS Bedrock           not set           anthropic.claude-sonnet,
                                                                           anthropic.claude-haiku
       ○     gemini                Google Gemini         not set           gemini-2.0-flash,
                                                                           gemini-2.0-flash-lite,
                                                                           gemini-2.5-pro
       ○     github-copilot        GitHub Copilot        not set           gpt-4o, gpt-4o-mini
       ○     minimax               Minimax               not set           MiniMax-M2.1,
                                                                           MiniMax-VL-01
       ○     qwen                  Qwen                  not set           qwen-max, qwen-turbo
       ○     moonshot              Moonshot              not set           kimi-k2.5,
                                                                           kimi-k2-instant
       ○     venice                Venice                not set           venice-default,
                                                                           venice-fast
       ○     cloudflare-ai         Cloudflare AI         not set           (configurable)
                                   Gateway
       ○     xiaomi-mimo           Xiaomi Mimo           not set           mimo-v2-flash

    Total Providers          13
```

---

## `wunderland models test openai`

```
  WUNDERLAND v0.27.0

  ◆ Testing OpenAI

  ✓ OPENAI_API_KEY is set
  ✓ API reachable (588ms)
```

---

## `wunderland channels`

```
  WUNDERLAND v0.27.0

  ◆ Channel Bindings

  ○ No channels configured.

  ◇ Run wunderland channels add or wunderland setup to configure channels.
```

---

## `wunderland voice`

```
  WUNDERLAND v0.27.0

  ◆ Voice Providers

    Twilio               not configured
      TWILIO_ACCOUNT_SID           not set
      TWILIO_AUTH_TOKEN            not set
    Telnyx               not configured
      TELNYX_API_KEY               not set
      TELNYX_CONNECTION_ID         not set
    Plivo                not configured
      PLIVO_AUTH_ID                not set
      PLIVO_AUTH_TOKEN             not set

  ◇ Configure voice providers via wunderland setup or by setting environment variables.
```

---

## `wunderland cron`

```
  WUNDERLAND v0.27.0

  ◆ Scheduled Jobs

  ○ No cron jobs configured locally.

  ◇ Cron jobs are managed via the Rabbithole dashboard or the agent's cron_manage tool.
  ◇ API: POST /wunderland/cron to create jobs programmatically.
```

---

## `wunderland skills list`

*Upgraded in v0.27.0: styled table with verified badge column*

```
  WUNDERLAND v0.27.0

  ◆ Available Skills

       ID                        Name                      Ver         Description               ✓
       ──────────────────────    ──────────────────────    ────────    ──────────────────────    ──
       com.framers.skill.wea…    weather                   1.0.0       Look up current           ✓
                                                                       weather conditions...
       com.framers.skill.git…    github                    1.0.0       Manage GitHub             ✓
                                                                       repositories...
       com.framers.skill.sla…    slack-helper              1.0.0       Manage Slack              ✓
                                                                       workspaces...
       com.framers.skill.dis…    discord-helper            1.0.0       Manage Discord            ✓
                                                                       servers...
       com.framers.skill.not…    notion                    1.0.0       Read, create, manage      ✓
                                                                       pages in Notion...
       com.framers.skill.obs…    obsidian                  1.0.0       Read, create, manage      ✓
                                                                       notes in Obsidian...
       com.framers.skill.sum…    summarize                 1.0.0       Summarize text            ✓
                                                                       content...
       com.framers.skill.cod…    coding-agent              1.0.0       Write, review, debug,     ✓
                                                                       refactor code...
       com.framers.skill.hea…    healthcheck               1.0.0       Monitor health and        ✓
                                                                       availability...
       com.framers.skill.spo…    spotify-player            1.0.0       Control Spotify           ✓
                                                                       playback...
       com.framers.skill.tre…    trello                    1.0.0       Manage Trello boards,     ✓
                                                                       lists, cards...
       com.framers.skill.app…    apple-notes               1.0.0       Create, read, search      ✓
                                                                       Apple Notes...
       com.framers.skill.app…    apple-reminders           1.0.0       Create, manage Apple      ✓
                                                                       Reminders...
       com.framers.skill.1pa…    1password                 1.0.0       Query 1Password           ✓
                                                                       vaults...
       com.framers.skill.ima…    image-gen                 1.0.0       Generate images from      ✓
                                                                       text prompts...
       com.framers.skill.whi…    whisper-transcribe        1.0.0       Transcribe audio/video    ✓
                                                                       via Whisper...
       com.framers.skill.git     git                       1.0.0       Work with Git             ✓
                                                                       repositories...

    Total                    17 skills
```

---

## `wunderland skills info weather`

```
  WUNDERLAND v0.27.0

  ◆ Skill: weather
    ID                       com.framers.skill.weather
    Version                  1.0.0
    Description              Look up current weather conditions, forecasts, and severe
                             weather alerts for any location worldwide.
    Verified                 yes
    Keywords                 weather, forecast, climate, location
    Source                   registry
```

---

## `wunderland plugins` (extensions list)

*Upgraded in v0.27.0: per-category styled tables with status badges*

```
  WUNDERLAND v0.27.0

  ◆ Extension Packs

  ◆ Tools

             Name                      Display Name              Status
       ──    ──────────────────────    ──────────────────────    ──────────────
       ✓     auth                      Authentication            installed
       ✓     web-search                Web Search                installed
       ✓     web-browser               Web Browser               installed
       ✓     cli-executor              CLI Executor              installed
       ✓     giphy                     Giphy                     installed
       ✓     image-search              Image Search              installed
       ✓     voice-synthesis           Voice Synthesis           installed
       ✓     news-search               News Search               installed
       ✓     skills                    Skills Registry           installed
       ○     browser-automation        Browser Automation        not installed
       ○     deep-research             Deep Research             not installed
       ... (20 total)

  ◆ Channels

             Name                      Display Name              Status
       ──    ──────────────────────    ──────────────────────    ──────────────
       ✓     channel-telegram          Telegram                  installed
       ✓     channel-whatsapp          WhatsApp                  installed
       ✓     channel-discord           Discord                   installed
       ✓     channel-slack             Slack                     installed
       ... (28 total)

  ◆ Voice Providers        (0/3 installed)
  ◆ Productivity           (0/2 installed)
  ◆ Integrations           (1/14 installed)

    Installed                32 / 67
```

---

## `wunderland extensions list`

```
  WUNDERLAND v0.27.0

  ◆ Available Extensions

  ◇ Tools:
      ✓ Authentication, Web Search, Web Browser, Telegram (Legacy),
        CLI Executor, Giphy, Image Search, Voice Synthesis, News Search,
        Skills Registry
      ✗ Browser Automation, Deep Research, Content Extraction,
        Credential Vault, Notifications, Video Search, Openverse,
        Sound Search, Music Search, Smithsonian, GitHub,
        OpenAI, Anthropic, Ollama, AWS Bedrock, Google Gemini,
        GitHub Copilot, Cloudflare AI, Minimax, Qwen, Moonshot,
        Xiaomi Mimo, Venice, OpenRouter

  ◇ Voice:
      ✗ Twilio Voice, Telnyx Voice, Plivo Voice

  ◇ Productivity:
      ✗ Google Calendar, Gmail

  ◇ Channels:
      ✓ Telegram, WhatsApp, Discord, Slack, WebChat, Signal,
        iMessage, Google Chat, Microsoft Teams, Matrix, ...
      and 18 more channels

  ◇ Total: 67 extensions (32 installed)
```

---

## `wunderland extensions info web-search`

```
  WUNDERLAND v0.27.0

  ◆ Extension: Web Search
    Name                     web-search
    Category                 tool
    Package                  @framers/agentos-ext-web-search
    Description              Web search using DuckDuckGo by default; optional
                             Serper/Brave API key for enhanced results.
    Status                   ✓ Installed
    Default Priority         20
```

---

## `wunderland rag`

```
  WUNDERLAND v0.27.0

  ◆ wunderland rag

  Subcommands:
    ingest <file|text>       Ingest a document
    ingest-image <file>      Ingest an image (LLM captioning)
    ingest-audio <file>      Ingest audio (Whisper transcription)
    query <text>             Search RAG memory
    query-media <text>       Search media assets
    collections [list|create|delete]  Manage collections
    documents [list|delete]  Manage documents
    graph [local-search|global-search|stats]  GraphRAG
    stats                    RAG statistics
    health                   Service health
    audit                    View audit trail

  Flags:
    --collection <id>  Target collection
    --format json|table  Output format
    --top-k <n>        Max results (default: 5)
    --preset <p>       Retrieval preset (fast|balanced|accurate)
    --graph             Include GraphRAG context in query results
    --debug             Show pipeline debug trace (query)
    --modality <m>     Media filter (image|audio)
    --category <c>     Document category
    --verbose, -v      Show audit trail (query) / per-op details (audit)
    --seed-id <id>     Filter by seed ID (audit)
    --limit <n>        Max results (audit, default: 20)
    --since <date>     Filter since ISO date (audit)
```

---

## `wunderland rag health`

```
  WUNDERLAND v0.27.0

  ◆ RAG Health
    Status                   ready
    Adapter                  better-sqlite3
    Vector Provider          sql
    Vector Store             connected
    Embeddings               available
    GraphRAG                 enabled
    Documents                5
    Chunks                   21
    Collections              1
```

---

## `wunderland rag stats`

```
  WUNDERLAND v0.27.0

  ◆ RAG Statistics
    Storage                  better-sqlite3
    Documents                5
    Chunks                   21
    Collections              1
      wunderland-docs        5 docs, 21 chunks
```

---

## `wunderland rag collections`

```
  WUNDERLAND v0.27.0

  ◆ RAG Collections
    wunderland-docs          5 docs, 21 chunks — Wunderland Documentation
```

---

## `wunderland rag documents list`

```
  WUNDERLAND v0.27.0

  ◆ RAG Documents
    doc_1771646034356_jsfxqacb [technical] collection=wunderland-docs
    doc_1771646033221_a1tctvgg [technical] collection=wunderland-docs
    doc_1771646032125_9gclfd6p [technical] collection=wunderland-docs
    doc_1771646031117_phshmsxy [technical] collection=wunderland-docs
    doc_1771646023937_rfm7nk5g [technical] collection=wunderland-docs
```

---

## `wunderland rag query "agent security model" --debug`

```
  WUNDERLAND v0.27.0

  ◆ RAG Query: "agent security model"
    [doc_...chunk_0] (100.0%) # Wunderland Security Model...
    [doc_...chunk_3] (58.9%)  ### Security Pipeline...
    [doc_...chunk_1] (55.4%)  ## Tier 3 Ollama...
    [doc_...chunk_1] (43.7%)  ### WunderlandSeed...
    [doc_...chunk_2] (36.9%)  ## SmallModelResolver...

  ◇ 5 result(s) in 6280ms

  ◆ Debug Pipeline Trace
      [+0ms] query_received    query=agent security model, preset=balanced,
                                topK=5, vectorProvider=sql
      [+1ms] variants_resolved baseQuery=agent security model, variantCount=0
      [+6279ms] vector_search  provider=sql, candidateCount=0, latencyMs=6278,
                                embeddingModel=text-embedding-3-small
      [+6280ms] keyword_search enabled=true, matchCount=5, latencyMs=1
      [+6280ms] fusion         strategy=RRF, vectorCount=0, keywordCount=5, mergedCount=5
      [+6280ms] pipeline_complete totalLatencyMs=6280, resultsReturned=5
```

---

## `wunderland rag query "security tiers" --graph`

```
  WUNDERLAND v0.27.0

  ◆ RAG Query: "security tiers"
    [doc_...chunk_0] (100.0%) # Wunderland Security Model...
    [doc_...chunk_3] (31.5%)  ### Security Pipeline...
    [doc_...chunk_1] (20.9%)  ### WunderlandSeed...
    [doc_...chunk_1] (19.9%)  ## Tier 3 Ollama...

  ◇ 4 result(s) in 323ms

  ◆ GraphRAG Context
    Entities                 5
      Security Tiers Five    (concept) 68%
      Wunderland Security Model (concept) 61%
      Security Tier          (concept) 53%
      Security Pipeline Three (concept) 50%
      Safe Guardrails        (concept) 47%
    Relationships            26
      Wunderland Security Model → Security Tiers Five [related_to]
      entity-ff2299e4 → Security Tier [related_to]
      ... and 20 more relationships
    Community Context        Wunderland Security Model, Security Tiers Five; ...
```

---

## `wunderland rag query "LLM providers" --graph --debug --verbose`

```
  WUNDERLAND v0.27.0

  ◆ RAG Query: "LLM providers"
    [doc_...chunk_0] (100.0%) # LLM Provider Ecosystem...
    [doc_...chunk_3] (67.1%)  ### Security Pipeline...
    [doc_...chunk_0] (58.5%)  # RAG System Design...
    [doc_...chunk_2] (48.8%)  ## Pre-LLM Classification...
    [doc_...chunk_2] (40.0%)  ## Document Processing...

  ◇ 5 result(s) in 689ms

  ◆ GraphRAG Context
    Entities                 5
    Relationships            42
    Community Context        Post, Social Dynamics Agents, Posts; ...

  ◆ Debug Pipeline Trace
      [+0ms] query_received    query=LLM providers, graphRagRequested=true
      [+1ms] variants_resolved baseQuery=LLM providers, variantCount=0
      [+677ms] vector_search  provider=sql, candidateCount=0, latencyMs=676
      [+678ms] keyword_search enabled=true, matchCount=5, latencyMs=1
      [+678ms] fusion         strategy=RRF, vectorCount=0, keywordCount=5, mergedCount=5
      [+689ms] graphrag       entitiesFound=5, relationships=42, searchTimeMs=11
      [+689ms] pipeline_complete totalLatencyMs=689, resultsReturned=5

  ◆ Audit Trail
    Trail ID                 trail-mlvyn6xw-1
    Summary                  2 ops | 0 LLM calls | 4 tokens | $0.0000 | 688ms
    Methods                  vector_query
    Sources                  4 docs, 0 data sources
```

---

## `wunderland rag audit`

```
  WUNDERLAND v0.27.0

  ◆ RAG Audit Trail
    [trail-mlvyn6]           "LLM providers" @ 2026-02-21T06:51:19.652Z
      Summary                2 ops | 0 LLM calls | 4 tokens | $0.0000 | 688ms

    [trail-mlvx73]           "agent architecture" @ 2026-02-21T06:10:49.147Z
      Summary                2 ops | 0 LLM calls | 5 tokens | $0.0000 | 614ms

    [trail-mlvskm]           "How does RAG retrieval fusion work?" @ 2026-02-21T04:01:22.102Z
      Summary                2 ops | 0 LLM calls | 9 tokens | $0.0000 | 1ms

    [trail-mlvsjv]           "How does the HEXACO personality model work?" @ 2026-02-21T04:00:47.253Z
      Summary                2 ops | 0 LLM calls | 11 tokens | $0.0000 | 146ms
```

---

## `wunderland rag graph stats`

```
  WUNDERLAND v0.27.0

  ◆ GraphRAG Statistics
    Entities                 148
    Relationships            356
    Communities              22
    Community Levels         2
    Documents Indexed        5
```

---

## `wunderland agency`

```
  WUNDERLAND v0.27.0

  ◆ wunderland agency

  Subcommands:
    list                   List configured agencies
    create <name>          Create a multi-agent agency
    status <name>          Show agency status
    add-seat <agency> <agent>  Add agent to agency
    handoff <from> <to>    Trigger agent handoff

  Flags:
    --format json|table    Output format
    --context <text>       Handoff context message
```

---

## `wunderland workflows`

```
  WUNDERLAND v0.27.0

  ◆ wunderland workflows

  Subcommands:
    list                List workflow definitions
    run <name>          Execute a workflow
    status <id>         Check workflow instance status
    cancel <id>         Cancel a running workflow

  Flags:
    --format json|table  Output format
```

---

## `wunderland evaluate`

```
  WUNDERLAND v0.27.0

  ◆ wunderland evaluate

  Subcommands:
    run <dataset>          Run evaluation against a dataset
    results <id>           Show evaluation results

  Flags:
    --judge <model>        LLM judge model (default: configured primary)
    --format json|table    Output format
```

---

## `wunderland knowledge`

```
  WUNDERLAND v0.27.0

  ◆ wunderland knowledge

  Subcommands:
    query <text>           Search the knowledge graph
    stats                  Show graph statistics
    demo                   Load a demo graph and show stats

  Flags:
    --format json|table    Output format
```

---

## `wunderland knowledge demo`

```
  WUNDERLAND v0.27.0

  ✓ Demo Knowledge Graph Created

    Entities                 4
    Relations                2
    Memories                 1
    Avg Confidence           90.5%

  Entities by Type
      person                 1
      concept                2
      organization           1

  ◇ Try: wunderland knowledge query Alice
```

---

## `wunderland knowledge stats`

```
  WUNDERLAND v0.27.0

  ◆ Knowledge Graph Statistics
  ◇ Knowledge graph is empty.
  ◇ Entities, relations, and episodic memories are created during agent runtime.
  ◇ Start an agent with: wunderland start
```

---

## `wunderland provenance`

```
  WUNDERLAND v0.27.0

  ◆ wunderland provenance

  Subcommands:
    audit                  Show audit trail and chain state
    verify                 Verify chain integrity (signatures + hashes)
    demo                   Create a demo chain and verify it

  Flags:
    --agent <id>           Filter by agent
    --format json|table    Output format
```

---

## `wunderland provenance demo`

```
  WUNDERLAND v0.27.0

  ◆ Provenance Demo
  ◇ Creating demo signed event chain...

  ✓ #1 agent.started      2026-02-21T06:50:15.832Z  hash: 735c886d...
  ✓ #2 message.received   2026-02-21T06:50:15.834Z  hash: f5a2fdc7...
  ✓ #3 tool.invoked        2026-02-21T06:50:15.834Z  hash: 0abbc011...
  ✓ #4 message.sent        2026-02-21T06:50:15.834Z  hash: ed41e757...
  ✓ #5 agent.stopped       2026-02-21T06:50:15.835Z  hash: 18e65e93...

    Chain Length             5
    Last Hash                18e65e93b9034275...
    Last Sequence            5

  ◇ Verifying chain integrity...

  ✓ Chain Verified
    5 events — all hashes and signatures valid.
```

---

## `wunderland marketplace`

```
  WUNDERLAND v0.27.0

  ◆ wunderland marketplace

  Subcommands:
    search <query>         Search skills, tools, channels & providers
    info <id>              Show item details
    install <id>           Install an extension (npm)

  Flags:
    --format json|table    Output format
    --source skills|tools|channels|providers  Filter by source
```

---

## `wunderland marketplace search "weather"`

```
  WUNDERLAND v0.27.0

  ◆ Marketplace: "weather"

  Skills
    ✓ weather                Look up current weather conditions, forecasts, and
                             severe weather alerts for any location worldwide.

    Results                  1 of 85 items
```

---

## `wunderland hitl`

```
  WUNDERLAND v0.27.0

  ✗ Missing HITL secret
    Provide --secret <token> or set WUNDERLAND_HITL_SECRET.
    Server UI: http://localhost:3777/hitl
```

---

## Interactive commands (not run — require TTY)

- `wunderland setup` — Interactive onboarding wizard
- `wunderland init <dir>` — Scaffold new project (prompts for preset)
- `wunderland create [description]` — Create agent from natural language
- `wunderland start` — Start local agent server (long-running)
- `wunderland chat` — Interactive terminal assistant (REPL)
- `wunderland channels add` — Add channel interactively
- `wunderland ollama-setup` — Configure Ollama (interactive)

---

## New in v0.27.0

### TUI Dashboard Mode

Running `wunderland` with no arguments in a TTY launches an interactive dashboard:

```
┌─ WUNDERLAND v0.27.0 ──────────────────────────────────────┐
│                                                            │
│  ◆ Agent: not configured     ◆ LLM: openai / gpt-4o-mini  │
│                                                            │
│  ┌─ Quick Actions ────────────────────────────────────────┐ │
│  │ > Start agent server                         [enter]   │ │
│  │   Open chat                                  [enter]   │ │
│  │   Run health check                           [enter]   │ │
│  │   Browse skills & extensions                 [enter]   │ │
│  │   Query RAG memory                           [enter]   │ │
│  │   Configure settings                         [enter]   │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                            │
│  ↑↓ navigate  ⏎ select  q quit                             │
└────────────────────────────────────────────────────────────┘
```

- Arrow keys navigate Quick Actions
- Enter drills into interactive views (doctor, models, skills, RAG, extensions, status)
- `q` exits cleanly (restores terminal)
- `--no-tui` forces print-and-exit mode
- `--tui` forces TUI even with `--quiet`
- Non-TTY (pipes, CI) automatically falls back to print-and-exit

### PNG Screenshot Export

Any command can be exported as a styled PNG screenshot:

```bash
wunderland doctor --export-png doctor.png
wunderland skills list --export-png skills.png
wunderland models --export-png models.png
wunderland status --export-png status.png
wunderland list-presets --export-png presets.png
wunderland plugins --export-png plugins.png
```

Pipeline: ANSI → HTML (themed, JetBrains Mono font) → PNG via Playwright (2x retina).

### Visual Upgrades

| Command | Before (v0.23) | After (v0.24) |
|---------|----------------|---------------|
| `doctor` | Flat `console.log` checks | Animated spinner per check (TTY), step progress |
| `status` | Plain text sections | Bordered `╭╮╰╯` panel cards per section |
| `list-presets` | Manual `padEnd()` tables | `cli-table3` styled tables |
| `skills list` | Manual formatting | `cli-table3` with verified badge column |
| `models` | Provider loop with text | Tabular grid with status badges |
| `plugins` | Category text blocks | Per-category `cli-table3` tables |
