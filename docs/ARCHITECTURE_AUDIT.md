# OpenStrand PKMS Architecture Audit

> Comprehensive audit of the Frame Codex codebase for the OpenStrand PKMS implementation
> 
> **Date**: December 3, 2025  
> **Status**: Phase 0 - Deep Architecture Investigation

---

## Executive Summary

This document provides a comprehensive audit of the existing Frame Codex architecture, identifying key components, patterns, and opportunities for enhancement as part of the OpenStrand PKMS implementation. The codebase demonstrates a well-structured, modular design with strong foundations in offline-first patterns, semantic search, and extensible plugin architecture.

---

## 1. Knowledge Hierarchy (Fabric → Weave → Loom → Strand)

### 1.1 Hierarchy Definition

From `packages/codex-viewer/src/lib/types.ts`:

| Level | Description | Example |
|-------|-------------|---------|
| **Fabric** | Collection of weaves (entire repository) | The complete Frame Codex repo |
| **Weave** | Top-level knowledge universe | `weaves/technology/` |
| **Loom** | Subdirectory inside a weave | `weaves/technology/web-dev/` |
| **Strand** | Individual markdown file | `weaves/technology/web-dev/react-basics.md` |
| **Folder** | Generic directory (outside weaves) | `docs/`, `scripts/` |

```typescript
// packages/codex-viewer/src/lib/types.ts
export type NodeLevel = 'fabric' | 'weave' | 'loom' | 'strand' | 'folder'
```

### 1.2 Strand Metadata Schema

Current strand metadata from YAML frontmatter (`packages/codex-viewer/src/lib/types.ts`):

```typescript
export interface StrandMetadata {
  id?: string                    // UUID
  slug?: string                  // URL-safe identifier
  title?: string                 // Display title
  version?: string               // Semantic version
  difficulty?: 'beginner' | 'intermediate' | 'advanced'
  taxonomy?: {
    subjects?: string[]          // High-level subjects
    topics?: string[]            // Specific topics
  }
  tags?: string | string[]       // Freeform tags
  contentType?: string           // Content classification
  relationships?: {
    references?: string[]        // Referenced strands
    prerequisites?: string[]     // Required prerequisite strands
  }
  publishing?: {
    status?: 'draft' | 'published' | 'archived'
    lastUpdated?: string
  }
  [key: string]: any             // Catch-all for custom fields
}
```

### 1.3 Knowledge Tree Structure

```typescript
export interface KnowledgeTreeNode {
  name: string                   // Display name
  path: string                   // Full path from repo root
  type: 'file' | 'dir'          // Node type
  children?: KnowledgeTreeNode[] // Child nodes (directories only)
  strandCount: number            // Total markdown files in subtree
  level: NodeLevel               // Codex hierarchy level
}
```

### 1.4 Current Component Map

| Component | Path | Purpose |
|-----------|------|---------|
| `CodexViewer` | `apps/frame.dev/components/codex/CodexViewer.tsx` | Main viewer container |
| `CodexSidebar` | `apps/frame.dev/components/codex/CodexSidebar.tsx` | Navigation tree |
| `CodexContent` | `apps/frame.dev/components/codex/CodexContent.tsx` | Content renderer |
| `CodexToolbar` | `apps/frame.dev/components/codex/CodexToolbar.tsx` | Action toolbar |
| `CodexMetadataPanel` | `apps/frame.dev/components/codex/CodexMetadataPanel.tsx` | Metadata display |

---

## 2. Taxonomy System

### 2.1 Current Classification

**Subjects** (parent categories):
- Defined in `taxonomy.subjects[]` frontmatter
- Represent high-level knowledge domains
- Example: "Programming", "Design", "Mathematics"

**Topics** (children):
- Defined in `taxonomy.topics[]` frontmatter
- More specific categorization
- Example: "React", "CSS Grid", "Linear Algebra"

**Tags**:
- Freeform labels in `tags` field
- Support both string and string array
- Used for cross-cutting concerns

### 2.2 Relationship Types

**Current Implementation** (`relationships` field):
```typescript
relationships?: {
  references?: string[]        // Cited/related strands
  prerequisites?: string[]     // Required prior knowledge
}
```

**Proposed Extensions** (OpenStrand Enhancement):
```typescript
relationships: {
  // Existing
  references?: string[]
  prerequisites?: string[]
  
  // New relationship types
  follows?: RelationshipRef[]      // Prerequisite learning path
  requires?: RelationshipRef[]     // Hard dependency
  extends?: RelationshipRef[]      // Builds upon
  contradicts?: RelationshipRef[]  // Opposing viewpoints
  examples?: RelationshipRef[]     // Illustrative content
  summarizes?: RelationshipRef[]   // Condensed version
  implements?: RelationshipRef[]   // Practical application
  questions?: RelationshipRef[]    // Raises inquiry about
}

interface RelationshipRef {
  targetSlug: string
  type: RelationshipType
  strength?: number              // 0.0 - 1.0
  bidirectional?: boolean
  reverseType?: RelationshipType
  metadata?: Record<string, unknown>
}
```

---

## 3. Semantic Search Architecture

### 3.1 Backend Hierarchy

From `apps/frame.dev/package.json` and component analysis:

```
1. WebGPU (if available) ─────┐
2. WASM-SIMD ────────────────────> @huggingface/transformers
3. ONNX Runtime Web ────────────> onnxruntime-web@1.20.0
4. Lexical/Full-text ─────────────> Fuse.js@7.1.0
```

### 3.2 Embedding Pipeline

**Pre-computed embeddings** (build-time):
```bash
# From package.json scripts
pnpm embeddings        # Generate embeddings
pnpm embeddings:full   # Generate embeddings + suggested questions
```

- Scripts: `scripts/generate-embeddings.js`, `scripts/generate-suggested-questions.js`
- Model downloaded via: `scripts/download-semantic-model.js`
- WASM files copied via: `scripts/copy-onnx-wasm.js`

### 3.3 NLP Tools in Use

| Tool | Version | Purpose |
|------|---------|---------|
| `compromise` | `^14.14.3` | Browser NLP (entity extraction, POS tagging) |
| `@huggingface/transformers` | `^3.8.0` | Transformer models for embeddings |
| `onnxruntime-web` | `^1.20.0` | ONNX model inference |
| `fuse.js` | `^7.1.0` | Fuzzy search fallback |

### 3.4 Search Components

| Component | Path | Purpose |
|-----------|------|---------|
| `SearchBar` | `components/codex/ui/SearchBar.tsx` | Main search interface |
| `SearchResultsPanel` | `components/codex/ui/SearchResultsPanel.tsx` | Results display |
| `SemanticSearchInfoPopover` | `components/codex/ui/SemanticSearchInfoPopover.tsx` | Search info |
| `useSearchFilter` | `components/codex/hooks/useSearchFilter.ts` | Search logic hook |

### 3.5 Feature Flags

From `CODEX_INTERNAL_SPEC.md`:
```typescript
interface CodexFeatureFlags {
  blockSummaries: boolean
  socraticNotes: boolean
  classification: boolean
  podcastGeneration: boolean
  imageGeneration: boolean
  storageLimitGb: number
  hostedGenerationsPerMonth: number
}
```

---

## 4. Current UI/UX State

### 4.1 Component Library

**Core UI Framework**:
- React 18.3.1
- Next.js 14.2.15
- Tailwind CSS 3.4.14

**Key Libraries**:
| Library | Version | Purpose |
|---------|---------|---------|
| `framer-motion` | `^11.0.23` | Animations |
| `lucide-react` | `^0.469.0` | Icons |
| `@radix-ui/react-tabs` | `^1.1.13` | Accessible tabs |
| `@tiptap/react` | `^3.10.7` | Rich text editing |
| `@tldraw/tldraw` | `2.0.2` | Whiteboard/canvas |
| `d3` | `^7.9.0` | Data visualization |

### 4.2 Design System Tokens

From `tailwind.config.ts`:

**Colors**:
```typescript
colors: {
  paper: {
    50: '#FDFCFB',    // Lightest
    100: '#FAF8F6',
    200: '#F5F2ED',
    // ... through 950
    950: '#2A241C',   // Darkest
  },
  ink: {
    50: '#F9FAFB',
    // ... through 950
    950: '#030712',
  },
  frame: {
    green: '#00C896',
    'green-light': '#00F4B4',
    'green-dark': '#009A74',
    'green-glow': '#00FFB8',
    accent: '#FF6B6B',
    'accent-light': '#FF9999',
  }
}
```

**Typography**:
```typescript
fontFamily: {
  'display': ['Playfair Display', 'Georgia', 'serif'],
  'sans': ['Inter', 'system-ui', 'sans-serif'],
  'mono': ['JetBrains Mono', 'Fira Code', 'monospace'],
}
```

**Responsive Font Sizes**:
```typescript
fontSize: {
  'responsive-xs': 'clamp(0.75rem, 1vw, 0.875rem)',
  'responsive-sm': 'clamp(0.875rem, 1.2vw, 1rem)',
  'responsive-base': 'clamp(1rem, 1.5vw, 1.125rem)',
  // ... through responsive-7xl
}
```

### 4.3 Animation System

**Defined Animations** (`tailwind.config.ts`):
- `fade-in` - Simple opacity fade
- `slide-up` / `slide-down` - Directional slides
- `scale-in` - Scale with opacity
- `rotate-in` - Rotation entrance
- `shimmer` - Loading shimmer effect
- `pulse-glow` - Glowing pulse (frame green)
- `draw-line` - SVG line draw
- `unfold` - 3D perspective unfold
- `page-turn` - 3D page turn effect

**Framer Motion Patterns** (from `DESIGN_SYSTEM.md`):
```typescript
// Physics-Inspired Easing
cubic-bezier(0.64, -0.58, 0.34, 1.56)  // Spring physics

// Duration Guidelines
150-350ms   // Microinteractions
0.5-0.8s    // Page transitions
```

### 4.4 Responsive Breakpoints

Standard Tailwind breakpoints used:
```css
sm: 640px    /* Small tablets */
md: 768px    /* Tablets */
lg: 1024px   /* Laptops */
xl: 1280px   /* Desktops */
2xl: 1536px  /* Large screens */
```

### 4.5 Current Graph Visualizations

| Component | Path | Status |
|-----------|------|--------|
| `KnowledgeGraphView` | `ui/KnowledgeGraphView.tsx` | Main graph view |
| `SpiralKnowledgeGraph` | `ui/SpiralKnowledgeGraph.tsx` | **Already exists!** |
| `StableKnowledgeGraph` | `ui/StableKnowledgeGraph.tsx` | Stable layout version |
| `InteractiveRelationGraph` | `ui/InteractiveRelationGraph.tsx` | Interactive graph |
| `CompactRelationGraph` | `ui/CompactRelationGraph.tsx` | Compact visualization |
| `MiniGraph` | `ui/MiniGraph.tsx` | Thumbnail graph |
| `FabricGraphView` | `ui/FabricGraphView.tsx` | Full fabric view |
| `FullFabricGraph` | `ui/FullFabricGraph.tsx` | Complete fabric graph |
| `SidebarGraphView` | `ui/SidebarGraphView.tsx` | Sidebar integration |

---

## 5. Existing Study/Learning Features

### 5.1 Auto-Generated Questions

From `ui/AutoGeneratedQuestions.tsx` and `ui/SuggestedQuestions.tsx`:
- Questions generated from content analysis
- Pre-computed during build (`scripts/generate-suggested-questions.js`)
- NLP-based extraction using compromise.js

### 5.2 Learning Path Features

| Component | Path | Description |
|-----------|------|-------------|
| `LearningPathPopup` | `ui/LearningPathPopup.tsx` | Learning path overlay |
| `TimelineView` | `ui/TimelineView.tsx` | Timeline visualization |
| `ContentInsights` | `ui/ContentInsights.tsx` | Content analysis display |

### 5.3 Q&A Interface

| Component | Path | Description |
|-----------|------|-------------|
| `QAInterface` | `ui/QAInterface.tsx` | Question/answer UI |
| `QAContextSelector` | `ui/QAContextSelector.tsx` | Context selection |
| `AnswerCard` | `ui/AnswerCard.tsx` | Answer display |

---

## 6. Offline-First Infrastructure

### 6.1 Storage Adapters

From `packages/sql-storage-adapter`:
- IndexedDB primary storage
- SQLite fallback (sql.js for browser)
- Capacitor support for mobile

### 6.2 PWA Support

| Component | Path | Purpose |
|-----------|------|---------|
| `usePWA` | `hooks/usePWA.ts` | PWA installation hook |
| `PWAInstallBanner` | `ui/PWAInstallBanner.tsx` | Install prompt |
| Service Worker | Build-time generated | Offline caching |

### 6.3 Local Data Persistence

From `hooks/useBookmarks.ts`, `hooks/usePreferences.ts`:
- LocalStorage for preferences
- IndexedDB for structured data
- Service worker caching for assets

---

## 7. Extension System

### 7.1 Plugin Architecture

From `packages/codex-extensions/src/types/index.ts`:

**Plugin Types**:
- `codex` - Data processing plugins
- `viewer` - UI/UX plugins

**Plugin Categories**:
```typescript
// Codex plugins
type CodexPluginCategory = 'indexer' | 'validator' | 'transformer' | 'analyzer' | 'exporter'

// Viewer plugins
type ViewerPluginCategory = 'ui-component' | 'visualization' | 'navigation' | 'search' | 'accessibility' | 'integration'
```

**Theme System**:
```typescript
interface ThemeColors {
  bgPrimary, bgSecondary, bgTertiary, bgPaper, bgOverlay  // Backgrounds
  textPrimary, textSecondary, textMuted, textInverse       // Text
  accent, accentHover, accentMuted                          // Accents
  success, warning, error, info                             // Semantic
  border, borderMuted, borderFocus                          // Borders
  syntax?: { keyword, string, number, comment, ... }        // Code
}
```

---

## 8. Accessibility Current State

### 8.1 Implemented Features

| Feature | Component/Hook | Status |
|---------|----------------|--------|
| Keyboard Navigation | `useKeyboardNavigation.ts` | ✅ Implemented |
| Focus Management | `useFocusManager.ts` | ✅ Implemented |
| Modal Accessibility | `useModalAccessibility.ts` | ✅ Implemented |
| Hotkeys | `useCodexHotkeys.ts` | ✅ Implemented |
| TTS/Read Aloud | `useTextToSpeech.ts`, `ReadAloudButton.tsx` | ✅ Implemented |
| Navigation Indicator | `KeyboardNavigationIndicator.tsx` | ✅ Implemented |

### 8.2 Theme Support

From `DESIGN_SYSTEM.md`:
- Light/Dark mode toggle
- Multiple theme variants (Sakura Sunset, Twilight Neo, Aurora Daybreak, Warm Embrace, Retro Terminus)
- `prefers-reduced-motion` respect in animation system

---

## 9. Dependency Analysis

### 9.1 Core Dependencies

```json
{
  "react": "^18.3.1",
  "next": "^14.2.15",
  "framer-motion": "^11.0.23",
  "d3": "^7.9.0",
  "tailwindcss": "^3.4.14",
  "@huggingface/transformers": "^3.8.0",
  "onnxruntime-web": "^1.20.0",
  "compromise": "^14.14.3",
  "fuse.js": "^7.1.0"
}
```

### 9.2 Rich Text / Editing

```json
{
  "@tiptap/react": "^3.10.7",
  "@tiptap/starter-kit": "^3.10.7",
  "@tldraw/tldraw": "2.0.2"
}
```

### 9.3 Build Tools

```json
{
  "typescript": "^5.6.3",
  "@tailwindcss/forms": "^0.5.9",
  "@tailwindcss/typography": "^0.5.12"
}
```

---

## 10. Gaps & Opportunities

### 10.1 Flashcard/Quiz System (Gap)

**Current State**: No dedicated flashcard or spaced repetition system exists.

**Opportunity**:
- Leverage existing `AutoGeneratedQuestions` infrastructure
- Add FSRS algorithm implementation
- Create `.study/` folder structure per strand
- Build review session UI with flip animations

### 10.2 Enhanced Relationships (Enhancement)

**Current State**: Basic `references` and `prerequisites` only.

**Opportunity**:
- Extend to full relationship type system
- Add bidirectional links with reverse semantics
- Implement relationship strength values
- Visualize in existing graph components

### 10.3 Learning Roadmaps (Gap)

**Current State**: `LearningPathPopup` and `TimelineView` exist but limited.

**Opportunity**:
- Create full roadmap data model
- Build drag-and-drop roadmap editor
- Integrate with `SpiralKnowledgeGraph`
- Add progress tracking

### 10.4 Achievement System (Gap)

**Current State**: No gamification features.

**Opportunity**:
- Design achievement schema
- Implement XP/level system
- Create celebration animations (leverage framer-motion)
- Build profile/trophy case UI

### 10.5 Mobile Experience (Enhancement)

**Current State**: Basic responsive design, PWA support exists.

**Opportunity**:
- Enhance bottom navigation (`MobileBottomNav.tsx`)
- Improve swipe gestures (`useSwipeGesture.ts`)
- Optimize touch targets for WCAG AA
- Add haptic feedback where appropriate

---

## 11. Recommended Architecture Enhancements

### 11.1 New Data Structures

```
strands/
└── [topic]/
    ├── strand.yml           # Enhanced metadata
    ├── index.md             # Content
    └── .study/              # NEW
        ├── flashcards.json  # Generated/custom flashcards
        ├── quizzes.json     # Quiz questions
        └── progress.json    # User progress (local only)
```

### 11.2 New Components

```
components/
├── study/                   # NEW - Study system
│   ├── FlashcardDeck.tsx
│   ├── FlashcardReview.tsx
│   ├── QuizSession.tsx
│   └── StudyStats.tsx
├── roadmap/                 # NEW - Learning roadmaps
│   ├── RoadmapEditor.tsx
│   ├── RoadmapTimeline.tsx
│   └── RoadmapProgress.tsx
├── achievements/            # NEW - Gamification
│   ├── AchievementCard.tsx
│   ├── TrophyCase.tsx
│   └── XPProgress.tsx
└── graph/                   # ENHANCED
    ├── EnhancedRelationGraph.tsx
    └── PathVisualizer.tsx
```

### 11.3 New Hooks

```typescript
// Study hooks
useFlashcards(strandId: string)
useSpacedRepetition(cardId: string)
useStudySession()
useStudyStats()

// Roadmap hooks  
useLearningRoadmap(roadmapId: string)
useRoadmapProgress()

// Achievement hooks
useAchievements()
useXPProgress()

// Enhanced relationship hooks
useRelationships(strandId: string)
useRelationshipGraph()
useLearningPath(fromSlug: string, toSlug: string)
```

---

## 12. Tech Stack Confirmation

| Category | Technology | Version |
|----------|------------|---------|
| Framework | Next.js | 14.2.15 |
| UI Library | React | 18.3.1 |
| Styling | Tailwind CSS | 3.4.14 |
| Animation | Framer Motion | 11.0.23 |
| State Management | React Context + Hooks | Built-in |
| Data Visualization | D3.js | 7.9.0 |
| NLP | Compromise.js | 14.14.3 |
| ML/Embeddings | @huggingface/transformers | 3.8.0 |
| Search | Fuse.js | 7.1.0 |
| Storage | IndexedDB (via sql-storage-adapter) | Custom |
| Rich Text | TipTap | 3.10.7 |
| Testing | Vitest | Via workspace |

---

## 13. Next Steps

1. **Phase 0 Complete**: Architecture audit documented ✅
2. **Phase 0 Next**: Create DESIGN_SYSTEM_AUDIT.md with WCAG AA analysis
3. **Phase 1**: Begin enhanced relationship system implementation
4. **Phase 1**: Extend existing graph components with new relationship types

---

*Last updated: December 3, 2025*

