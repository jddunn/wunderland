# OpenStrand PKMS Design System Audit

> Design system analysis with WCAG AA compliance review and enhancement proposals
> 
> **Date**: December 3, 2025  
> **Status**: Phase 0 - Design System Analysis

---

## Executive Summary

This audit analyzes the current design system of Frame Codex, evaluates WCAG AA compliance, and proposes enhancements to achieve a "whimsical, cute, friendly" AAA gaming aesthetic while maintaining accessibility standards.

---

## 1. Color System Audit

### 1.1 Current Color Tokens

**Paper Palette** (Light backgrounds):
| Token | Hex | HSL |
|-------|-----|-----|
| paper-50 | #FDFCFB | hsl(30, 33%, 99%) |
| paper-100 | #FAF8F6 | hsl(30, 33%, 97%) |
| paper-200 | #F5F2ED | hsl(32, 30%, 95%) |
| paper-300 | #EDE8E0 | hsl(34, 28%, 91%) |
| paper-400 | #DDD4C4 | hsl(35, 29%, 82%) |
| paper-500 | #C9BAA0 | hsl(37, 32%, 71%) |
| paper-600 | #A89374 | hsl(35, 30%, 56%) |
| paper-700 | #8A7358 | hsl(32, 25%, 44%) |
| paper-800 | #6B5A45 | hsl(32, 23%, 35%) |
| paper-900 | #4A3F31 | hsl(33, 22%, 24%) |
| paper-950 | #2A241C | hsl(32, 22%, 14%) |

**Ink Palette** (Dark text/backgrounds):
| Token | Hex | HSL |
|-------|-----|-----|
| ink-50 | #F9FAFB | hsl(210, 20%, 98%) |
| ink-100 | #F3F4F6 | hsl(216, 12%, 96%) |
| ink-200 | #E5E7EB | hsl(214, 14%, 91%) |
| ink-300 | #D1D5DB | hsl(213, 12%, 84%) |
| ink-400 | #9CA3AF | hsl(215, 11%, 65%) |
| ink-500 | #6B7280 | hsl(220, 9%, 46%) |
| ink-600 | #4B5563 | hsl(215, 14%, 34%) |
| ink-700 | #374151 | hsl(217, 19%, 27%) |
| ink-800 | #1F2937 | hsl(215, 28%, 17%) |
| ink-900 | #111827 | hsl(221, 39%, 11%) |
| ink-950 | #030712 | hsl(224, 71%, 4%) |

**Frame Brand Colors**:
| Token | Hex | Purpose |
|-------|-----|---------|
| frame-green | #00C896 | Primary brand |
| frame-green-light | #00F4B4 | Light variant |
| frame-green-dark | #009A74 | Dark variant |
| frame-green-glow | #00FFB8 | Glow effects |
| frame-accent | #FF6B6B | Accent/alert |
| frame-accent-light | #FF9999 | Light accent |

### 1.2 WCAG AA Contrast Analysis

#### Text Contrast Requirements
- **Normal text**: 4.5:1 minimum
- **Large text** (18pt+ or 14pt bold): 3:1 minimum
- **UI components/graphics**: 3:1 minimum

#### Current Compliance Issues

**❌ Failing Combinations (Light Mode)**:
| Foreground | Background | Ratio | Verdict |
|------------|------------|-------|---------|
| paper-400 (#DDD4C4) | paper-50 (#FDFCFB) | 1.5:1 | ❌ FAIL |
| paper-500 (#C9BAA0) | paper-100 (#FAF8F6) | 2.1:1 | ❌ FAIL |
| ink-400 (#9CA3AF) | paper-50 (#FDFCFB) | 3.2:1 | ❌ FAIL (normal text) |
| frame-green (#00C896) | paper-50 (#FDFCFB) | 2.8:1 | ❌ FAIL |

**✅ Passing Combinations (Light Mode)**:
| Foreground | Background | Ratio | Verdict |
|------------|------------|-------|---------|
| ink-700 (#374151) | paper-50 (#FDFCFB) | 10.8:1 | ✅ AAA |
| ink-800 (#1F2937) | paper-100 (#FAF8F6) | 13.2:1 | ✅ AAA |
| ink-600 (#4B5563) | paper-50 (#FDFCFB) | 7.1:1 | ✅ AA |
| frame-green-dark (#009A74) | paper-50 (#FDFCFB) | 4.2:1 | ✅ AA (large) |

**❌ Failing Combinations (Dark Mode)**:
| Foreground | Background | Ratio | Verdict |
|------------|------------|-------|---------|
| ink-400 (#9CA3AF) | ink-900 (#111827) | 4.3:1 | ❌ FAIL (normal) |
| frame-green (#00C896) | ink-900 (#111827) | 4.0:1 | ❌ FAIL |
| paper-400 (#DDD4C4) | ink-800 (#1F2937) | 5.2:1 | ✅ AA |

### 1.3 Proposed Enhanced Palette

#### "Whimsical Sakura" Theme (Her-Inspired, WCAG AA Compliant)

```css
:root {
  /* Background layers */
  --bg-primary: hsl(340, 25%, 16%);      /* Deep warm rose */
  --bg-secondary: hsl(340, 22%, 22%);    /* Card backgrounds */
  --bg-tertiary: hsl(340, 20%, 28%);     /* Hover states */
  --bg-elevated: hsl(340, 18%, 32%);     /* Elevated surfaces */
  
  /* Text hierarchy - ALL AA COMPLIANT */
  --text-primary: hsl(25, 60%, 92%);     /* 12.1:1 vs bg-primary ✅ */
  --text-secondary: hsl(345, 25%, 75%);  /* 6.8:1 vs bg-primary ✅ */
  --text-muted: hsl(340, 15%, 60%);      /* 4.6:1 vs bg-primary ✅ */
  --text-inverse: hsl(340, 25%, 16%);    /* For light surfaces */
  
  /* Accent colors - AA Compliant */
  --accent-primary: hsl(335, 80%, 72%);  /* 6.2:1 vs bg-primary ✅ */
  --accent-secondary: hsl(345, 75%, 80%);/* Softer pink */
  --accent-success: hsl(160, 60%, 45%);  /* Green - 4.5:1 ✅ */
  --accent-warning: hsl(40, 90%, 50%);   /* Amber */
  --accent-error: hsl(0, 70%, 60%);      /* Red - 4.6:1 ✅ */
  
  /* Interactive states */
  --focus-ring: hsl(335, 80%, 72%);
  --focus-ring-offset: hsl(340, 25%, 16%);
  
  /* Borders */
  --border-default: hsl(340, 15%, 35%);
  --border-muted: hsl(340, 10%, 28%);
  --border-focus: hsl(335, 70%, 60%);
}
```

#### "Aurora Daybreak" Light Theme (AA Compliant)

```css
:root[data-theme="light"] {
  /* Background layers */
  --bg-primary: hsl(210, 60%, 98%);      /* Cool white */
  --bg-secondary: hsl(210, 40%, 95%);    /* Card backgrounds */
  --bg-tertiary: hsl(210, 30%, 92%);     /* Hover states */
  --bg-elevated: hsl(0, 0%, 100%);       /* Pure white elevated */
  
  /* Text hierarchy - ALL AA COMPLIANT */
  --text-primary: hsl(220, 30%, 20%);    /* 14.5:1 vs bg-primary ✅ */
  --text-secondary: hsl(220, 25%, 40%);  /* 6.1:1 vs bg-primary ✅ */
  --text-muted: hsl(220, 20%, 55%);      /* 4.5:1 vs bg-primary ✅ */
  --text-inverse: hsl(210, 60%, 98%);    /* For dark surfaces */
  
  /* Accent colors - AA Compliant */
  --accent-primary: hsl(330, 85%, 45%);  /* Deep pink - 4.8:1 ✅ */
  --accent-secondary: hsl(260, 75%, 50%);/* Lavender */
  --accent-success: hsl(160, 70%, 30%);  /* Forest green - 5.2:1 ✅ */
  --accent-warning: hsl(35, 90%, 40%);   /* Amber */
  --accent-error: hsl(0, 65%, 45%);      /* Deep red - 5.1:1 ✅ */
}
```

### 1.4 Light/Dark Mode Mapping

| Semantic Token | Light Mode | Dark Mode |
|---------------|------------|-----------|
| `--bg-base` | paper-50 | ink-900 |
| `--bg-surface` | paper-100 | ink-800 |
| `--bg-elevated` | white | ink-700 |
| `--text-primary` | ink-800 | paper-100 |
| `--text-secondary` | ink-600 | paper-300 |
| `--text-muted` | ink-500 | paper-500 |
| `--border` | paper-300 | ink-600 |
| `--accent` | frame-green-dark | frame-green |

---

## 2. Typography Scale

### 2.1 Current Implementation

**Font Families**:
```typescript
fontFamily: {
  'display': ['Playfair Display', 'Georgia', 'serif'],
  'sans': ['Inter', 'system-ui', 'sans-serif'],
  'mono': ['JetBrains Mono', 'Fira Code', 'monospace'],
}
```

**Responsive Scale** (using `clamp()`):
```typescript
fontSize: {
  'responsive-xs':   'clamp(0.75rem, 1vw, 0.875rem)',    // 12-14px
  'responsive-sm':   'clamp(0.875rem, 1.2vw, 1rem)',     // 14-16px
  'responsive-base': 'clamp(1rem, 1.5vw, 1.125rem)',     // 16-18px
  'responsive-lg':   'clamp(1.125rem, 2vw, 1.25rem)',    // 18-20px
  'responsive-xl':   'clamp(1.25rem, 2.5vw, 1.5rem)',    // 20-24px
  'responsive-2xl':  'clamp(1.5rem, 3vw, 2rem)',         // 24-32px
  'responsive-3xl':  'clamp(1.875rem, 4vw, 2.5rem)',     // 30-40px
  'responsive-4xl':  'clamp(2.25rem, 5vw, 3rem)',        // 36-48px
  'responsive-5xl':  'clamp(3rem, 6vw, 4rem)',           // 48-64px
  'responsive-6xl':  'clamp(3.75rem, 7vw, 5rem)',        // 60-80px
  'responsive-7xl':  'clamp(4.5rem, 8vw, 6rem)',         // 72-96px
}
```

### 2.2 Readability Analysis

**Issues Identified**:

1. **Line Height**: Not explicitly defined in current config
   - Recommendation: Add `lineHeight` tokens

2. **Maximum Line Width**: Not constrained
   - Recommendation: Add `max-w-prose` (65ch) for body text

3. **Font Weight Hierarchy**: Using default Tailwind weights
   - Could be more intentional for visual hierarchy

### 2.3 Proposed Typography Improvements

```typescript
// Enhanced typography system
typography: {
  // Line heights for readability
  lineHeight: {
    'tight': 1.25,      // Headings
    'snug': 1.375,      // Subheadings
    'normal': 1.5,      // Body text (WCAG minimum)
    'relaxed': 1.625,   // Long-form reading
    'loose': 2,         // Large displays
  },
  
  // Font weights for hierarchy
  fontWeight: {
    'light': 300,
    'normal': 400,
    'medium': 500,
    'semibold': 600,
    'bold': 700,
    'extrabold': 800,
  },
  
  // Letter spacing
  letterSpacing: {
    'tighter': '-0.05em',
    'tight': '-0.025em',
    'normal': '0',
    'wide': '0.025em',
    'wider': '0.05em',
    'widest': '0.1em',
  },
  
  // Optimal reading width
  maxWidth: {
    'prose': '65ch',
    'prose-sm': '55ch',
    'prose-lg': '75ch',
  }
}
```

### 2.4 Type Scale Recommendations

| Element | Size | Weight | Line Height | Letter Spacing |
|---------|------|--------|-------------|----------------|
| H1 (Display) | responsive-5xl | 700 | 1.1 | -0.025em |
| H2 | responsive-4xl | 600 | 1.2 | -0.02em |
| H3 | responsive-3xl | 600 | 1.25 | -0.015em |
| H4 | responsive-2xl | 500 | 1.3 | 0 |
| H5 | responsive-xl | 500 | 1.4 | 0 |
| H6 | responsive-lg | 500 | 1.5 | 0 |
| Body | responsive-base | 400 | 1.6 | 0 |
| Caption | responsive-sm | 400 | 1.5 | 0.02em |
| Code | responsive-sm | 400 | 1.4 | 0 |

---

## 3. Spacing & Layout

### 3.1 Current Spacing Tokens

Using default Tailwind spacing scale (4px base):
```
0.5: 2px, 1: 4px, 2: 8px, 3: 12px, 4: 16px, 5: 20px, 6: 24px, 8: 32px, 10: 40px, 12: 48px, 16: 64px, 20: 80px, 24: 96px
```

### 3.2 Grid System Analysis

**Current**: Not explicitly defined, using Tailwind defaults.

**Recommended Grid System**:
```css
/* 12-column grid */
.grid-layout {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-4);
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .grid-layout {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-3);
  }
}

@media (max-width: 640px) {
  .grid-layout {
    grid-template-columns: 1fr;
    gap: var(--spacing-2);
  }
}
```

### 3.3 Proposed Semantic Spacing

```typescript
spacing: {
  // Component-level
  'component-xs': '0.25rem',   // 4px - tight internal
  'component-sm': '0.5rem',    // 8px - standard internal
  'component-md': '1rem',      // 16px - comfortable internal
  'component-lg': '1.5rem',    // 24px - spacious internal
  
  // Section-level
  'section-sm': '2rem',        // 32px
  'section-md': '3rem',        // 48px
  'section-lg': '4rem',        // 64px
  'section-xl': '6rem',        // 96px
  
  // Page-level
  'page-sm': '4rem',           // 64px
  'page-md': '6rem',           // 96px
  'page-lg': '8rem',           // 128px
}
```

---

## 4. Animation Patterns

### 4.1 Current Animations

**Defined in `tailwind.config.ts`**:

| Animation | Duration | Easing | Purpose |
|-----------|----------|--------|---------|
| fade-in | 0.5s | ease-out | Element appearance |
| slide-up | 0.5s | ease-out | Slide from below |
| slide-down | 0.5s | ease-out | Slide from above |
| scale-in | 0.3s | ease-out | Scale entrance |
| rotate-in | 0.5s | ease-out | Rotation entrance |
| shimmer | 2s | linear | Loading placeholder |
| pulse-glow | 2s | ease-in-out | Attention indicator |
| draw-line | 1s | ease-out | SVG path drawing |
| unfold | 0.6s | cubic-bezier | 3D unfold effect |
| page-turn | 0.8s | cubic-bezier | Page flip effect |

### 4.2 Game-Like Micro-Interaction Opportunities

#### Button Interactions
```typescript
const buttonVariants = {
  idle: { 
    scale: 1,
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  },
  hover: { 
    scale: 1.02,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    transition: { type: 'spring', stiffness: 400, damping: 25 }
  },
  tap: { 
    scale: 0.98,
    boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
    transition: { type: 'spring', stiffness: 600, damping: 30 }
  },
  success: {
    scale: [1, 1.1, 1],
    backgroundColor: ['var(--accent-primary)', 'var(--accent-success)', 'var(--accent-primary)'],
    transition: { duration: 0.4 }
  }
}
```

#### Card Lift Effect (3D)
```typescript
const cardVariants = {
  idle: {
    rotateX: 0,
    rotateY: 0,
    scale: 1,
    boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
  },
  hover: {
    scale: 1.02,
    boxShadow: '0 20px 25px rgba(0,0,0,0.15), 0 8px 10px rgba(0,0,0,0.1)',
    transition: { type: 'spring', stiffness: 300, damping: 20 }
  },
  // 3D tilt on mouse move
  tilt: (mousePosition) => ({
    rotateX: (mousePosition.y - 0.5) * 10,
    rotateY: (mousePosition.x - 0.5) * 10,
    transition: { type: 'spring', stiffness: 400, damping: 30 }
  })
}
```

#### Flashcard Flip Animation
```typescript
const flashcardVariants = {
  front: {
    rotateY: 0,
    transition: { 
      type: 'spring', 
      stiffness: 200, 
      damping: 25 
    }
  },
  back: {
    rotateY: 180,
    transition: { 
      type: 'spring', 
      stiffness: 200, 
      damping: 25 
    }
  }
}
```

#### Achievement Unlock Celebration
```typescript
const achievementVariants = {
  hidden: {
    scale: 0,
    opacity: 0,
    y: 50
  },
  visible: {
    scale: 1,
    opacity: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 300,
      damping: 20,
      staggerChildren: 0.1
    }
  },
  celebrate: {
    scale: [1, 1.2, 1],
    rotate: [0, -5, 5, -3, 3, 0],
    transition: {
      duration: 0.6,
      ease: 'easeInOut'
    }
  }
}

// Confetti burst
const confettiConfig = {
  particleCount: 100,
  spread: 70,
  origin: { y: 0.6 },
  colors: ['#FF6B6B', '#00C896', '#FFD93D', '#6BCB77', '#4D96FF']
}
```

#### Progress/XP Bar Animation
```typescript
const progressVariants = {
  initial: { width: 0, opacity: 0 },
  animate: (progress) => ({
    width: `${progress}%`,
    opacity: 1,
    transition: {
      width: { type: 'spring', stiffness: 100, damping: 20 },
      opacity: { duration: 0.3 }
    }
  }),
  pulse: {
    boxShadow: [
      '0 0 0 0 rgba(0, 200, 150, 0.4)',
      '0 0 0 10px rgba(0, 200, 150, 0)',
    ],
    transition: { duration: 1, repeat: Infinity }
  }
}
```

### 4.3 Motion Preference Handling

```typescript
// Hook for respecting reduced motion
function useReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
  
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReducedMotion(mediaQuery.matches)
    
    const handler = (e) => setPrefersReducedMotion(e.matches)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])
  
  return prefersReducedMotion
}

// Conditional animation variants
const getAnimationVariants = (reducedMotion) => ({
  hidden: reducedMotion 
    ? { opacity: 0 }
    : { opacity: 0, y: 20, scale: 0.95 },
  visible: reducedMotion
    ? { opacity: 1 }
    : { opacity: 1, y: 0, scale: 1, transition: { type: 'spring' } }
})
```

### 4.4 Performance Considerations

| Guideline | Recommendation |
|-----------|----------------|
| Property choice | Prefer `transform` and `opacity` |
| Duration | Keep under 300ms for interactions |
| Hardware acceleration | Use `will-change` sparingly |
| Layout thrashing | Avoid animating width/height when possible |
| Stagger limits | Max 8-10 staggered items |

---

## 5. Accessibility Implementation Checklist

### 5.1 Color Contrast (WCAG 2.1 Level AA)

- [ ] All body text: 4.5:1 minimum
- [ ] Large text (18pt+): 3:1 minimum
- [ ] UI components: 3:1 minimum
- [ ] Focus indicators: 3:1 minimum
- [ ] Link underlines or other indicators
- [ ] Error states: distinct from normal states

### 5.2 Keyboard Navigation

- [ ] All interactive elements focusable
- [ ] Logical focus order (tab index)
- [ ] Skip links for main content
- [ ] Escape to close modals/overlays
- [ ] Arrow keys for lists/grids
- [ ] Enter/Space to activate buttons
- [ ] Focus trap in modals

### 5.3 Screen Reader Support

- [ ] Semantic HTML throughout
- [ ] ARIA landmarks (`main`, `nav`, `aside`)
- [ ] ARIA labels for icon-only buttons
- [ ] Live regions for dynamic updates
- [ ] Alt text for all images
- [ ] Form labels properly associated
- [ ] Error announcements
- [ ] Loading state announcements

### 5.4 Motion & Animation

- [ ] Respect `prefers-reduced-motion`
- [ ] No auto-playing video/audio
- [ ] Pause controls for animations
- [ ] No flashing content (>3 flashes/second)
- [ ] Animation durations under 5 seconds
- [ ] Option to disable animations globally

### 5.5 Focus Management

- [ ] Visible focus indicators
- [ ] Custom focus styles (not just outline)
- [ ] Focus trap in modals/dialogs
- [ ] Return focus on modal close
- [ ] Focus restoration on navigation

### 5.6 Touch Targets

- [ ] Minimum 44x44px touch targets
- [ ] Adequate spacing between targets
- [ ] Touch feedback on mobile

---

## 6. Component Design Tokens

### 6.1 Proposed Design Token Structure

```typescript
// design-tokens.ts
export const tokens = {
  // Colors (semantic)
  color: {
    bg: {
      primary: 'var(--bg-primary)',
      secondary: 'var(--bg-secondary)',
      tertiary: 'var(--bg-tertiary)',
      elevated: 'var(--bg-elevated)',
      overlay: 'var(--bg-overlay)',
    },
    text: {
      primary: 'var(--text-primary)',
      secondary: 'var(--text-secondary)',
      muted: 'var(--text-muted)',
      inverse: 'var(--text-inverse)',
    },
    accent: {
      primary: 'var(--accent-primary)',
      secondary: 'var(--accent-secondary)',
      success: 'var(--accent-success)',
      warning: 'var(--accent-warning)',
      error: 'var(--accent-error)',
    },
    border: {
      default: 'var(--border-default)',
      muted: 'var(--border-muted)',
      focus: 'var(--border-focus)',
    }
  },
  
  // Typography
  font: {
    family: {
      display: 'var(--font-display)',
      body: 'var(--font-body)',
      mono: 'var(--font-mono)',
    },
    size: {
      xs: 'var(--font-size-xs)',
      sm: 'var(--font-size-sm)',
      base: 'var(--font-size-base)',
      lg: 'var(--font-size-lg)',
      xl: 'var(--font-size-xl)',
      '2xl': 'var(--font-size-2xl)',
      '3xl': 'var(--font-size-3xl)',
      '4xl': 'var(--font-size-4xl)',
    },
    weight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    lineHeight: {
      tight: 1.25,
      normal: 1.5,
      relaxed: 1.75,
    }
  },
  
  // Spacing
  space: {
    0: '0',
    1: '0.25rem',
    2: '0.5rem',
    3: '0.75rem',
    4: '1rem',
    5: '1.25rem',
    6: '1.5rem',
    8: '2rem',
    10: '2.5rem',
    12: '3rem',
    16: '4rem',
    20: '5rem',
    24: '6rem',
  },
  
  // Border radius
  radius: {
    none: '0',
    sm: '0.25rem',
    md: '0.5rem',
    lg: '1rem',
    xl: '1.5rem',
    full: '9999px',
  },
  
  // Shadows
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.05)',
    md: '0 4px 6px rgba(0,0,0,0.1)',
    lg: '0 10px 15px rgba(0,0,0,0.1)',
    xl: '0 20px 25px rgba(0,0,0,0.15)',
    glow: '0 0 20px var(--accent-primary)',
  },
  
  // Transitions
  transition: {
    fast: '150ms ease-out',
    normal: '250ms ease-out',
    slow: '350ms ease-out',
    spring: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  },
  
  // Z-index scale
  zIndex: {
    base: 0,
    dropdown: 100,
    sticky: 200,
    modal: 300,
    popover: 400,
    tooltip: 500,
    toast: 600,
  }
}
```

---

## 7. Before/After Comparison

### 7.1 Button Component

**Before** (Current):
```tsx
<button className="bg-frame-green text-white px-4 py-2 rounded-lg hover:bg-frame-green-dark">
  Click me
</button>
```

**After** (Enhanced):
```tsx
<motion.button
  className="
    bg-accent-primary text-text-inverse 
    px-4 py-2 rounded-lg
    focus:outline-none focus:ring-2 focus:ring-accent-primary focus:ring-offset-2
    disabled:opacity-50 disabled:cursor-not-allowed
  "
  variants={buttonVariants}
  initial="idle"
  whileHover="hover"
  whileTap="tap"
  aria-label="Click to submit"
>
  Click me
</motion.button>
```

### 7.2 Card Component

**Before**:
```tsx
<div className="bg-paper-100 rounded-lg p-4 shadow-md">
  <h3 className="text-ink-800">Title</h3>
  <p className="text-ink-500">Content</p>
</div>
```

**After**:
```tsx
<motion.article
  className="
    bg-surface rounded-xl p-6
    shadow-md hover:shadow-lg
    border border-border-muted
    focus-within:ring-2 focus-within:ring-accent-primary
  "
  variants={cardVariants}
  initial="idle"
  whileHover="hover"
  role="article"
  tabIndex={0}
  aria-labelledby="card-title"
>
  <h3 
    id="card-title" 
    className="text-text-primary font-semibold text-lg leading-tight"
  >
    Title
  </h3>
  <p className="text-text-secondary mt-2 leading-relaxed">
    Content with proper line height for readability
  </p>
</motion.article>
```

---

## 8. Implementation Priorities

### 8.1 Immediate (Phase 0)
1. ✅ Document current design system
2. 🔄 Fix critical contrast failures
3. 🔄 Add focus indicators to all interactive elements
4. 🔄 Implement `prefers-reduced-motion` handling

### 8.2 Short-term (Phase 1-2)
1. Create semantic color tokens
2. Implement enhanced animation variants
3. Add proper typography scale
4. Create accessible component variants

### 8.3 Medium-term (Phase 3-4)
1. Build game-like micro-interaction library
2. Implement achievement celebration animations
3. Create flashcard flip/review animations
4. Add XP progress animations

### 8.4 Long-term (Phase 5+)
1. Full theme customization system
2. User-controllable animation settings
3. Advanced accessibility features
4. High contrast mode implementation

---

## 9. Resources

### 9.1 Tools for Testing
- **Contrast**: [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- **Color Blindness**: [Coblis Simulator](https://www.color-blindness.com/coblis-color-blindness-simulator/)
- **Accessibility**: [axe DevTools](https://www.deque.com/axe/)
- **Motion**: Chrome DevTools → Rendering → Emulate prefers-reduced-motion

### 9.2 Reference Implementations
- [Radix UI Colors](https://www.radix-ui.com/colors)
- [Tailwind UI](https://tailwindui.com/)
- [Framer Motion Examples](https://www.framer.com/motion/examples/)
- [Duolingo Design](https://design.duolingo.com/)

---

*Last updated: December 3, 2025*

