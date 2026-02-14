# AgentOS Site Page - Additional Implementation Details

## 📚 TypeDoc Generation & Search Integration

### TypeDoc Setup
```typescript
// scripts/generate-docs.ts
import { Application, TSConfigReader } from 'typedoc';

export async function generateDocs() {
  const app = new Application();

  app.options.addReader(new TSConfigReader());
  app.bootstrap({
    entryPoints: ['../packages/agentos/src/index.ts'],
    out: 'public/docs',
    json: 'public/docs/docs.json', // For search indexing
    theme: 'default',
    excludePrivate: true,
    excludeInternal: true,
    categorizeByGroup: true,
    navigationLinks: {
      'GitHub': 'https://github.com/framersai/agentos',
      'AgentOS': 'https://agentos.sh'
    }
  });

  const project = await app.convert();
  if (project) {
    await app.generateDocs(project, 'public/docs');
    await app.generateJson(project, 'public/docs/docs.json');
  }
}

// Run during build
// npm run build:docs
```

### Documentation Search Widget
```typescript
// components/docs/DocSearch.tsx
import { useState, useEffect } from 'react';
import Fuse from 'fuse.js';

interface DocSearchResult {
  name: string;
  kind: string;
  url: string;
  description?: string;
}

export function DocSearch() {
  const [searchIndex, setSearchIndex] = useState<Fuse<DocSearchResult>>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DocSearchResult[]>([]);

  useEffect(() => {
    // Load TypeDoc JSON and create search index
    fetch('/docs/docs.json')
      .then(res => res.json())
      .then(data => {
        const items = extractSearchableItems(data);
        const fuse = new Fuse(items, {
          keys: ['name', 'description'],
          threshold: 0.3
        });
        setSearchIndex(fuse);
      });
  }, []);

  const handleSearch = (q: string) => {
    setQuery(q);
    if (searchIndex && q.length > 2) {
      const searchResults = searchIndex.search(q).slice(0, 10);
      setResults(searchResults.map(r => r.item));
    } else {
      setResults([]);
    }
  };

  return (
    <div className="doc-search">
      <input
        type="search"
        placeholder="Search docs... (e.g., AgentOS, GMI, processRequest)"
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        className="search-input"
      />
      {results.length > 0 && (
        <div className="search-results">
          {results.map((result, idx) => (
            <a
              key={idx}
              href={`/docs${result.url}`}
              className="search-result-item"
            >
              <span className="result-kind">{result.kind}</span>
              <span className="result-name">{result.name}</span>
              {result.description && (
                <span className="result-description">{result.description}</span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
```

## 🎨 Theme Configuration

### Default Theme with System Detection
```typescript
// lib/theme.ts
export function getDefaultTheme(): Theme {
  // Check system preference
  if (typeof window !== 'undefined') {
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (systemPrefersDark) {
      // Dark mode: Use Twilight Neo
      return 'twilight-neo';
    }
  }

  // Light mode default: Aurora Daybreak
  return 'aurora-daybreak';
}

// components/theme-provider.tsx
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState<Theme>(() => {
    // Check localStorage first
    const saved = localStorage.getItem('agentos-theme');
    if (saved) return saved as Theme;

    // Otherwise use system default
    return getDefaultTheme();
  });

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (!localStorage.getItem('agentos-theme')) {
        setTheme(getDefaultTheme());
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);
}
```

## 🎭 Testimonials & Social Proof

### Placeholder Testimonials
```typescript
// data/testimonials.ts
export const testimonials = [
  {
    id: 'testimonial-1',
    author: 'Sarah Chen',
    role: 'Senior AI Engineer',
    company: 'TechCorp',
    image: '/testimonials/placeholder-1.jpg', // Generic avatar
    content: 'AgentOS transformed how we build conversational AI. The streaming architecture and persona system are game-changers.',
    rating: 5
  },
  {
    id: 'testimonial-2',
    author: 'Marcus Rodriguez',
    role: 'CTO',
    company: 'AI Startup',
    image: '/testimonials/placeholder-2.jpg',
    content: 'We deployed 50+ custom agents in just 2 weeks. The tool orchestration saved us months of development.',
    rating: 5
  },
  {
    id: 'testimonial-3',
    author: 'Emily Watson',
    role: 'Product Manager',
    company: 'Enterprise Co',
    image: '/testimonials/placeholder-3.jpg',
    content: 'The guardrail system and subscription-aware limits gave us confidence to go to production quickly.',
    rating: 5
  }
];

// Social proof numbers (placeholders)
export const socialProof = {
  developers: '10,000+',
  enterprises: '50+',
  countries: '25+',
  githubStars: '5,000+', // Will be dynamic later
  communityMembers: '2,500+'
};
```

## 📱 Mobile-Specific Layouts

### Responsive Design Strategy
```typescript
// hooks/useResponsive.ts
export function useResponsive() {
  const [device, setDevice] = useState<'mobile' | 'tablet' | 'desktop'>('desktop');

  useEffect(() => {
    const checkDevice = () => {
      const width = window.innerWidth;
      if (width < 640) setDevice('mobile');
      else if (width < 1024) setDevice('tablet');
      else setDevice('desktop');
    };

    checkDevice();
    window.addEventListener('resize', checkDevice);
    return () => window.removeEventListener('resize', checkDevice);
  }, []);

  return { device, isMobile: device === 'mobile' };
}

// Mobile-optimized components
// components/mobile/MobileHero.tsx
export function MobileHero() {
  // Simplified layout for mobile
  // Same animations but touch-optimized
  // Swipeable cards instead of grid
  // Bottom sheet CTAs
}
```

## 📝 Initial Blog Posts

### Blog Post 1: Design Philosophy
```markdown
---
title: "The Design Philosophy Behind AgentOS"
date: "2024-01-15"
author: "The Framers Team"
category: "Design"
excerpt: "How we built a visual language for adaptive AI systems"
coverImage: "/blog/design-philosophy-cover.jpg"
tags: ["design", "ui", "theming", "architecture"]
---

# The Design Philosophy Behind AgentOS

When we set out to build AgentOS, we knew we weren't just creating another AI framework. We were designing a new way for developers to think about adaptive, context-aware AI systems. This philosophy extends from our core architecture all the way to our visual design.

## Five Themes, Five Personalities

Our theme system isn't just about aesthetics—it's about matching the energy and personality of your AI agents:

- **Sakura Sunset**: Inspired by the film "Her," this theme embodies digital empathy and warmth
- **Twilight Neo**: Sharp, precise, and energetic for high-performance computing contexts
- **Aurora Daybreak**: Clean and professional for enterprise deployments
- **Warm Embrace**: Cozy and approachable for consumer-facing applications
- **Retro Terminus**: Brutalist and functional for developers who appreciate minimalism

## Architecture as Visual Language

Every animation and transition in our landing page reflects the underlying AgentOS architecture:

- **Streaming particles** represent real-time data flow
- **Glowing connections** show tool orchestration
- **Breathing effects** indicate active listening states
- **Layered cards** mirror our hierarchical persona system

## Performance Through Design

We've optimized every pixel for performance:
- Lazy-loaded media with smart placeholders
- GPU-accelerated animations
- Responsive images with next-gen formats
- Progressive enhancement for all devices

## Open Source, Premium Experience

While AgentOS is MIT-licensed and free to use, we believe open source deserves premium design. That's why we've invested in creating the most beautiful, functional landing page in the AI space.

[Continue reading about our technical architecture →](/blog/technical-deep-dive)
```

### Blog Post 2: Getting Started Guide
```markdown
---
title: "Getting Started with AgentOS: Your First Adaptive Agent"
date: "2024-01-20"
author: "The Framers Team"
category: "Tutorial"
excerpt: "Build your first context-aware AI agent in 10 minutes"
coverImage: "/blog/getting-started-cover.jpg"
tags: ["tutorial", "quickstart", "development", "personas"]
---

# Getting Started with AgentOS: Your First Adaptive Agent

Ready to build AI that actually understands context? Let's create your first adaptive agent with AgentOS.

## Installation

\`\`\`bash
npm install @framers/agentos
# or
pnpm add @framers/agentos
\`\`\`

## Your First Persona

Let's create a simple but powerful persona that adapts to user skill levels:

\`\`\`typescript
import { AgentOS, IPersonaDefinition } from '@framers/agentos';

const tutorialAssistant: IPersonaDefinition = {
  identity: {
    name: "Tutor",
    role: "adaptive_teacher"
  },
  promptConfig: {
    baseSystemPrompt: "You are a helpful programming tutor.",
    contextualElements: [
      {
        id: "beginner_mode",
        type: "system_instruction_addon",
        content: "Explain concepts simply with analogies",
        criteria: { userSkillLevel: "beginner" }
      },
      {
        id: "expert_mode",
        type: "system_instruction_addon",
        content: "Provide concise, technical explanations",
        criteria: { userSkillLevel: "expert" }
      }
    ]
  }
};
\`\`\`

## Initialize AgentOS

\`\`\`typescript
const agentOS = new AgentOS();
await agentOS.initialize({
  personas: [tutorialAssistant],
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY
});
\`\`\`

## Process Requests with Context

\`\`\`typescript
// Beginner gets simple explanation
const beginnerResponse = await agentOS.processRequest({
  text: "What is recursion?",
  context: { userSkillLevel: "beginner" }
});

// Expert gets technical details
const expertResponse = await agentOS.processRequest({
  text: "What is recursion?",
  context: { userSkillLevel: "expert" }
});
\`\`\`

## Streaming Responses

For real-time applications, use streaming:

\`\`\`typescript
for await (const chunk of agentOS.streamRequest(request)) {
  if (chunk.type === 'text_delta') {
    process.stdout.write(chunk.content);
  }
}
\`\`\`

## Next Steps

- [Explore the persona gallery →](/personas)
- [Learn about tool orchestration →](/docs/tools)
- [Try Voice Chat Assistant →](https://app.vca.chat/en)
- [Browse the marketplace →](https://vca.chat)

## Join the Community

Ready to build something amazing? Join thousands of developers creating the next generation of AI applications:

- Star us on [GitHub](https://github.com/framersai/agentos)
- Join our [Discord](https://discord.gg/agentos)
- Follow [@frame_dev](https://twitter.com/frame_dev) for updates

[View full documentation →](https://docs.agentos.sh)
```

## 🚀 Repository Structure

### Separate Public Repository Setup
```bash
# Create new public repository
mkdir agentos.sh
cd agentos.sh
git init

# Add as submodule to main repo
cd ../voice-chat-assistant
git submodule add https://github.com/framersai/agentos.sh apps/agentos.sh

# Structure
agentos.sh/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── blog/
│   │   └── [slug]/
│   │       └── page.tsx
│   └── api/
│       ├── metrics/
│       └── newsletter/
├── components/
├── content/
│   └── blog/
├── public/
│   ├── media/
│   │   ├── videos/
│   │   ├── gifs/
│   │   └── screenshots/
│   ├── docs/ (generated)
│   └── testimonials/
├── lib/
├── scripts/
│   └── generate-docs.ts
├── styles/
├── package.json
├── README.md
├── LICENSE (MIT)
└── .env.example
```

## 🎯 Early Access Banner

```typescript
// components/banners/EarlyAccessBanner.tsx
export function EarlyAccessBanner() {
  const showBanner = process.env.NEXT_PUBLIC_SHOW_EARLY_ACCESS_BANNER === 'true';
  const [dismissed, setDismissed] = useState(false);

  if (!showBanner || dismissed) return null;

  return (
    <motion.div
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      className="early-access-banner"
    >
      <div className="banner-content">
        <Sparkle className="banner-icon" />
        <span>{process.env.NEXT_PUBLIC_EARLY_ACCESS_MESSAGE}</span>
        <a href="https://app.vca.chat/en" className="banner-cta">
          Try Demo
        </a>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="banner-dismiss"
        aria-label="Dismiss banner"
      >
        <X />
      </button>
    </motion.div>
  );
}
```

## 📊 Hero Section Variations

### All Animation Types in Different Sections

```typescript
// app/page.tsx structure
<main>
  {/* Hero with particle animation */}
  <HeroSection animation="particles" />

  {/* Architecture with data flow */}
  <ArchitectureSection animation="dataflow" />

  {/* Features with glowing connections */}
  <FeaturesSection animation="connections" />

  {/* Code playground with syntax animation */}
  <CodePlaygroundSection animation="typing" />

  {/* Marketplace with card animations */}
  <MarketplaceSection animation="cards" />

  {/* Testimonials with fade/slide */}
  <TestimonialsSection animation="fade" />
</main>
```

## 🔄 File Naming Convention for Media

### Easy Media Replacement System
```typescript
// public/media/ structure
media/
├── videos/
│   ├── hero-demo.mp4 (main hero video)
│   ├── tool-orchestration.mp4
│   ├── persona-switching.mp4
│   ├── streaming-demo.mp4
│   └── marketplace-preview.mp4
├── gifs/
│   ├── hero-demo.gif (fallback for video)
│   ├── tool-orchestration.gif
│   ├── persona-switching.gif
│   ├── code-completion.gif
│   └── theme-switching.gif
└── screenshots/
    ├── dashboard-full.png
    ├── dashboard-mobile.png
    ├── code-editor.png
    ├── persona-gallery.png
    ├── tool-chain.png
    └── marketplace.png

// Component automatically checks existence
const MediaPlayer = ({ filename, type }) => {
  const [exists, setExists] = useState(false);

  useEffect(() => {
    fetch(`/media/${type}s/${filename}`)
      .then(res => setExists(res.ok))
      .catch(() => setExists(false));
  }, [filename, type]);

  if (!exists) {
    return <PlaceholderAnimation type={type} />;
  }

  // Render actual media
};
```