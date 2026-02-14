# Reactive State System Documentation

## Overview

The Reactive State System is a comprehensive visual feedback framework inspired by the movie "Her" (2013). It creates an intimate, responsive interface that dynamically adapts to user interactions and application states through fluid animations, organic transitions, and ambient effects.

## Table of Contents

1. [Architecture](#architecture)
2. [Core Concepts](#core-concepts)
3. [Installation & Setup](#installation--setup)
4. [State Management](#state-management)
5. [Visual Effects](#visual-effects)
6. [Component Integration](#component-integration)
7. [Usage Guide](#usage-guide)
8. [API Reference](#api-reference)
9. [Theming](#theming)
10. [Performance](#performance)
11. [Examples](#examples)
12. [Troubleshooting](#troubleshooting)

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Reactive State Store                      │
│  (reactive.store.ts)                                         │
│  • State Management (idle, listening, thinking, etc.)        │
│  • Mood States (calm, engaged, excited, etc.)                │
│  • Effect Parameters (intensity, glow, particles, etc.)      │
│  • CSS Variable Generation                                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┴─────────────┬─────────────────────┐
        ▼                           ▼                     ▼
┌───────────────┐          ┌────────────────┐    ┌──────────────────┐
│  UI Components│          │  SCSS System   │    │  Composables     │
│               │          │                │    │                  │
│ • AnimatedLogo│          │ • _global.scss │    │ • useTextAnimation│
│ • HearingIcon │          │ • _reactive-   │    │ • useVoiceViz    │
│ • MobileNav   │          │   effects.scss │    │                  │
└───────────────┘          └────────────────┘    └──────────────────┘
```

### Data Flow

1. **Reactive Store** → Manages state and generates CSS variables
2. **CSS Variables** → Applied to `:root` for global access
3. **Components** → Read state and apply appropriate classes
4. **SCSS System** → Uses CSS variables for dynamic styling
5. **Visual Feedback** → User sees responsive, animated interface

## Core Concepts

### States

The system recognizes distinct application states:

- **`idle`** - Default resting state
- **`listening`** - Actively receiving voice input
- **`transcribing`** - Converting speech to text
- **`thinking`** - Processing/analyzing input
- **`responding`** - Generating response
- **`speaking`** - Text-to-speech output
- **`vad-wake`** - Voice activation detection ready
- **`vad-active`** - Voice activity detected
- **`processing`** - Generic processing state
- **`error`** - Error condition
- **`connecting`** - Establishing connection

### Moods

Emotional overlays that modify visual behavior:

- **`calm`** - Subdued, peaceful animations
- **`engaged`** - Active, responsive feedback
- **`excited`** - Energetic, vibrant effects
- **`contemplative`** - Thoughtful, slower transitions
- **`attentive`** - Focused, precise movements
- **`curious`** - Exploratory, dynamic patterns
- **`warm`** - Inviting, soft interactions

### Visual Effects

- **Border Pulse** - Animated gradient borders
- **Glow Effects** - Dynamic shadow/light emanation
- **Ripple Animation** - Touch/click feedback
- **Particle System** - Floating ambient elements
- **Neural Network** - Thinking state visualization
- **Text Streaming** - Character/word reveal animations

## Installation & Setup

### 1. Install Dependencies

```bash
npm install gsap @vueuse/core
```

### 2. Import Reactive Store

```typescript
// In your main app file or component
import { useReactiveStore } from '@/store/reactive.store';
import { useUiStore } from '@/store/ui.store';
```

### 3. Initialize in App.vue

```vue
<template>
  <div id="app" :style="reactiveStore.cssVariables.value">
    <!-- Your app content -->
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useReactiveStore } from '@/store/reactive.store';
import { useUiStore } from '@/store/ui.store';

const reactiveStore = useReactiveStore();
const uiStore = useUiStore();

onMounted(async () => {
  // Initialize theme and reactive system
  await uiStore.initializeTheme();
  reactiveStore.transitionToState('idle');
});
</script>
```

### 4. Import SCSS

```scss
// In your main.scss
@use 'styles/components/reactive-effects';
@use 'styles/components/text-animations';
@use 'styles/utilities/reactive-states';
```

## State Management

### Transitioning Between States

```typescript
const reactiveStore = useReactiveStore();

// Simple state transition
reactiveStore.transitionToState('listening');

// With custom duration
reactiveStore.transitionToState('thinking', { 
  duration: 800,
  easing: 'ease-in-out' 
});

// With delay
reactiveStore.transitionToState('responding', { 
  duration: 600,
  delay: 200 
});
```

### Setting Moods

```typescript
// Set mood (affects visual warmth and energy)
reactiveStore.setMoodState('engaged');

// Set mood with transition
reactiveStore.setMoodState('contemplative', true);
```

### Triggering Effects

```typescript
// Ripple effect
reactiveStore.triggerRipple({
  duration: 1000,
  intensity: 0.8,
  count: 2
});

// Glow burst
reactiveStore.triggerGlowBurst(0.9, 600);

// Pulse effect
reactiveStore.triggerPulse(0.8, 800);
```

## Visual Effects

### Border Pulse

Animated gradient borders that pulse with state changes:

```html
<div class="reactive-container" data-reactive-state="listening">
  <!-- Content -->
</div>
```

```scss
.my-element {
  @include reactive-border-pulse(
    $color-var-prefix: '--color-accent-primary',
    $duration: 2s,
    $glow-radius: 10px
  );
}
```

### Glow Effects

Dynamic shadow/light emanation:

```html
<div class="has-reactive-glow">
  <!-- Glowing content -->
</div>
```

### Ripple Animation

Touch/click feedback:

```html
<button class="reactive-button" @click="handleClick">
  Click me
</button>
```

```typescript
function handleClick(event: MouseEvent) {
  reactiveStore.triggerRipple({
    duration: 800,
    intensity: 0.6
  });
}
```

### Particle System

Ambient floating elements:

```html
<div class="particle-system" v-if="reactiveStore.particleActivity.value > 0">
  <div 
    v-for="i in 20" 
    :key="`particle-${i}`"
    class="particle"
  />
</div>
```

## Component Integration

### AnimatedLogo

Enhanced logo with agent name transitions:

```vue
<AnimatedLogo
  app-name-main="VCA"
  show-subtitle
  subtitle="Voice Assistant"
  :animate-on-mount="true"
  :interactive="true"
  @agent-change="handleAgentChange"
/>
```

### HearingIndicator

State-aware visual indicator:

```vue
<HearingIndicator
  :size="60"
  :show-label="false"
  :interactive="true"
  :custom-state="customState"
  @state-change="handleStateChange"
/>
```

### Enhanced Text Animation

```vue
<script setup>
import { useTextAnimation } from '@/composables/useTextAnimation';

const { animatedUnits, animateText, isAnimating } = useTextAnimation({
  adaptToState: true,
  adaptToContent: true
});

// Animate text with state awareness
animateText(message, {
  mode: 'word',
  animationStyle: 'organic',
  particleEffect: true
});
</script>

<template>
  <div class="animated-text-container">
    <span
      v-for="unit in animatedUnits"
      :key="unit.key"
      :class="unit.classes"
      :style="unit.style"
    >
      {{ unit.content }}
    </span>
  </div>
</template>
```

## Usage Guide

### Basic Container Setup

```html
<!-- Automatic state application -->
<div class="main-content" data-reactive-state="listening">
  <!-- Content automatically gets listening effects -->
</div>

<!-- Manual class application -->
<div class="reactive-container state-thinking">
  <!-- Thinking state effects -->
</div>
```

### Input Fields

```html
<div class="reactive-input-container" :class="{ 'is-focused': isFocused }">
  <input 
    @focus="isFocused = true"
    @blur="isFocused = false"
  />
</div>
```

### Chat Messages

```html
<div class="reactive-message" :class="{ 'streaming': isStreaming }">
  {{ messageContent }}
</div>
```

### Buttons with Feedback

```html
<button class="reactive-button reactive-hover reactive-focus">
  Interactive Button
</button>
```

### Intensity Modifiers

```html
<!-- Low intensity -->
<div class="reactive-element reactive-intensity-low">
  Subtle effects
</div>

<!-- High intensity -->
<div class="reactive-element reactive-intensity-high">
  Prominent effects
</div>
```

### Combined Effects

```html
<!-- Full listening mode -->
<div class="reactive-listening-mode">
  <!-- Includes glow, border pulse, and engaged mood -->
</div>

<!-- Full thinking mode -->
<div class="reactive-thinking-mode">
  <!-- Includes neural effects, particles, and contemplative mood -->
</div>
```

## API Reference

### Reactive Store

#### State Properties

```typescript
interface ReactiveStore {
  // Read-only state
  appState: Readonly<Ref<AppState>>;
  moodState: Readonly<Ref<MoodState>>;
  activeEffects: Readonly<Ref<Set<VisualEffect>>>;
  
  // Visual parameters (0-1)
  intensity: Readonly<Ref<number>>;
  pulseRate: Readonly<Ref<number>>;
  pulseIntensity: Readonly<Ref<number>>;
  gradientShift: Readonly<Ref<number>>;
  gradientSpeed: Readonly<Ref<number>>;
  rippleActive: Readonly<Ref<boolean>>;
  rippleIntensity: Readonly<Ref<number>>;
  glowIntensity: Readonly<Ref<number>>;
  glowRadius: Readonly<Ref<number>>;
  particleActivity: Readonly<Ref<number>>;
  neuralActivity: Readonly<Ref<number>>;
  warmth: Readonly<Ref<number>>;
  borderAnimation: Readonly<Ref<boolean>>;
  borderPulseSpeed: Readonly<Ref<number>>;
  textStreamSpeed: Readonly<Ref<number>>;
  
  // Computed
  cssVariables: Readonly<ComputedRef<Record<string, string>>>;
  currentStateConfig: Readonly<ComputedRef<ReactiveStateConfig>>;
}
```

#### Methods

```typescript
// State transitions
transitionToState(
  newState: AppState, 
  config?: TransitionConfig
): void;

// Mood management
setMoodState(
  mood: MoodState, 
  transition?: boolean
): void;

// Effect triggers
triggerRipple(config?: RippleConfig): void;
triggerPulse(intensity?: number, duration?: number): void;
triggerGlowBurst(intensity?: number, duration?: number): void;

// Effect management
addEffect(effect: VisualEffect): void;
removeEffect(effect: VisualEffect): void;
hasEffect(effect: VisualEffect): boolean;

// Manual adjustments
adjustIntensity(delta: number): void;
adjustPulseRate(delta: number): void;

// Utility
reset(): void;
getInterpolatedValue(key: keyof ReactiveStateConfig): number;
```

### CSS Variables

Generated and available globally:

```css
:root {
  /* Core reactive variables */
  --reactive-intensity: 0-1;
  --reactive-pulse-rate: 0-1;
  --reactive-pulse-intensity: 0-1;
  --reactive-gradient-shift: 0-1;
  --reactive-gradient-speed: 0-1;
  --reactive-glow-intensity: 0-1;
  --reactive-glow-radius: px;
  --reactive-particle-activity: 0-1;
  --reactive-neural-activity: 0-1;
  --reactive-warmth: 0-1;
  --reactive-ripple-scale: 0-1;
  --reactive-ripple-intensity: 0-1;
  --reactive-border-pulse-speed: s;
  --reactive-text-stream-speed: 0-1;
  
  /* Computed gradients */
  --reactive-gradient-start: hsl();
  --reactive-gradient-end: hsl();
  
  /* Effect colors */
  --reactive-ripple-color: hsla();
  --reactive-neural-color: hsla();
}
```

### SCSS Mixins

```scss
// Border pulse effect
@include reactive-border-pulse(
  $color-var-prefix: '--color-accent-primary',
  $duration: 2s,
  $glow-radius: 10px
);

// Glow effect
@include reactive-glow(
  $color-var-prefix: '--color-accent-glow',
  $base-radius: 20px,
  $spread: 0.5
);

// Ripple container
@include reactive-ripple-container();

// Apply state effects
@include apply-state-effects($state);
```

## Theming

### Theme-Specific Configurations

```typescript
const THEME_REACTIVE_CONFIGS = {
  'sakura-blush': {
    preferredStates: ['idle', 'listening', 'responding'],
    moodModifiers: { warm: 1.2, calm: 1.1 },
    effectIntensity: 0.8,
    particleMultiplier: 1.2,
  },
  'twilight-neon': {
    preferredStates: ['thinking', 'processing', 'responding'],
    moodModifiers: { excited: 1.3, curious: 1.2 },
    effectIntensity: 1.0,
    particleMultiplier: 1.5,
  },
  // ... more themes
};
```

### Theme Integration

```typescript
// Theme changes trigger reactive effects
await uiStore.setTheme('twilight-neon');
// Automatically adjusts effect intensity and triggers transition effects
```

## Performance

### Optimization Strategies

1. **Reduced Motion Support**
```css
@media (prefers-reduced-motion: reduce) {
  /* Animations are automatically disabled */
}
```

2. **Mobile Optimization**
```html
<div class="reactive-element reactive-mobile-optimize">
  <!-- Reduced particle and neural effects -->
</div>
```

3. **Touch Device Optimization**
```scss
@media (hover: none) and (pointer: coarse) {
  .reactive-touch-optimize {
    /* Heavy effects disabled */
  }
}
```

4. **Effect Throttling**
```typescript
// Limit effect frequency
const throttledRipple = throttle(() => {
  reactiveStore.triggerRipple();
}, 300);
```

### Best Practices

1. **Use State Transitions Wisely**
   - Don't transition too frequently
   - Use appropriate durations
   - Consider user actions

2. **Optimize for Context**
   - Reduce effects in list views
   - Increase effects for focus areas
   - Balance performance and visual feedback

3. **Respect User Preferences**
   - Always check `isReducedMotionPreferred`
   - Provide settings to disable effects
   - Ensure functionality without animations

## Examples

### Voice Input Component

```vue
<template>
  <div 
    class="voice-input-wrapper"
    :data-reactive-state="currentState"
  >
    <div class="voice-visualization" v-if="isListening">
      <canvas ref="vizCanvas" />
    </div>
    
    <button
      class="voice-button reactive-button"
      @click="toggleListening"
    >
      <HearingIndicator 
        :size="40"
        :custom-state="currentState"
      />
    </button>
    
    <div 
      class="transcription-display"
      :class="{ 'streaming': isTranscribing }"
    >
      <div class="animated-text-container">
        <span
          v-for="unit in animatedUnits"
          :key="unit.key"
          :class="unit.classes"
          :style="unit.style"
        >
          {{ unit.content }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useReactiveStore } from '@/store/reactive.store';
import { useTextAnimation } from '@/composables/useTextAnimation';
import HearingIndicator from '@/components/ui/HearingIndicator.vue';

const reactiveStore = useReactiveStore();
const { animatedUnits, animateText } = useTextAnimation();

const isListening = ref(false);
const isTranscribing = ref(false);
const transcription = ref('');

const currentState = computed(() => {
  if (isTranscribing.value) return 'transcribing';
  if (isListening.value) return 'listening';
  return 'idle';
});

watch(currentState, (newState) => {
  reactiveStore.transitionToState(newState);
});

watch(transcription, (newText) => {
  if (newText) {
    animateText(newText, {
      mode: 'word',
      animationStyle: 'wave',
      adaptToState: true
    });
  }
});

function toggleListening() {
  isListening.value = !isListening.value;
  
  if (isListening.value) {
    reactiveStore.setMoodState('attentive');
    reactiveStore.triggerGlowBurst(0.8, 600);
  } else {
    reactiveStore.setMoodState('calm');
  }
}
</script>
```

### Chat Message Component

```vue
<template>
  <div 
    class="message-wrapper reactive-message"
    :class="{
      'streaming': isStreaming,
      'user-message': message.role === 'user',
      'assistant-message': message.role === 'assistant'
    }"
    :data-message-state="messageState"
  >
    <div class="message-avatar">
      <component 
        :is="avatarComponent"
        :state="messageState"
      />
    </div>
    
    <div class="message-content">
      <div class="message-header">
        <span class="sender-name">{{ senderName }}</span>
        <span class="timestamp">{{ formattedTime }}</span>
      </div>
      
      <div class="message-body">
        <template v-if="isAnimating">
          <span
            v-for="unit in animatedUnits"
            :key="unit.key"
            :class="unit.classes"
            :style="unit.style"
          >
            {{ unit.content }}
          </span>
        </template>
        <div v-else v-html="renderedContent" />
      </div>
    </div>
    
    <div 
      class="message-actions"
      v-if="showActions"
    >
      <button 
        class="action-button reactive-hover"
        @click="copyMessage"
      >
        <CopyIcon />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useReactiveStore } from '@/store/reactive.store';
import { useTextAnimation } from '@/composables/useTextAnimation';
import type { ChatMessage } from '@/types';

const props = defineProps<{
  message: ChatMessage;
  isStreaming?: boolean;
}>();

const reactiveStore = useReactiveStore();
const { animatedUnits, animateText, isAnimating } = useTextAnimation();

const messageState = computed(() => {
  if (props.isStreaming) return 'streaming';
  if (props.message.role === 'assistant') return 'responding';
  return 'idle';
});

onMounted(() => {
  if (props.message.role === 'assistant' && props.message.content) {
    // Animate assistant messages
    animateText(props.message.content, {
      mode: 'word',
      animationStyle: 'organic',
      baseSpeed: 35,
      adaptToState: true,
      particleEffect: true
    });
    
    // Trigger effects for new messages
    reactiveStore.triggerRipple({
      duration: 1200,
      intensity: 0.6
    });
  }
});

function copyMessage() {
  navigator.clipboard.writeText(props.message.content);
  reactiveStore.triggerPulse(0.7, 400);
}
</script>
```

### Reactive Dashboard

```vue
<template>
  <div class="dashboard reactive-container" :data-reactive-state="dashboardState">
    <!-- Header with state indicator -->
    <header class="dashboard-header reactive-header">
      <AnimatedLogo />
      <div class="state-indicators">
        <HearingIndicator 
          :size="30"
          :show-label="true"
        />
      </div>
    </header>
    
    <!-- Main content area -->
    <main class="dashboard-main">
      <!-- Agent cards with reactive states -->
      <div class="agent-grid">
        <div 
          v-for="agent in agents"
          :key="agent.id"
          class="agent-card reactive-card"
          :class="{ 'highlight': agent.id === activeAgentId }"
          @click="selectAgent(agent)"
        >
          <div class="agent-icon">
            <component :is="agent.icon" />
          </div>
          <h3>{{ agent.name }}</h3>
          <p>{{ agent.description }}</p>
        </div>
      </div>
      
      <!-- Chat area -->
      <div 
        class="chat-area reactive-chat-container"
        :class="{
          'is-streaming': isStreaming,
          'is-waiting': isWaitingForResponse
        }"
      >
        <ChatWindow 
          :messages="messages"
          @new-message="handleNewMessage"
        />
      </div>
    </main>
    
    <!-- Particle system overlay -->
    <div 
      class="particle-system"
      v-if="reactiveStore.particleActivity.value > 0"
    >
      <div 
        v-for="i in particleCount"
        :key="`particle-${i}`"
        class="particle"
        :style="getParticleStyle(i)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useReactiveStore } from '@/store/reactive.store';
import AnimatedLogo from '@/components/ui/AnimatedLogo.vue';
import HearingIndicator from '@/components/ui/HearingIndicator.vue';
import ChatWindow from '@/components/ChatWindow.vue';

const reactiveStore = useReactiveStore();

const activeAgentId = ref(null);
const isStreaming = ref(false);
const isWaitingForResponse = ref(false);
const messages = ref([]);

const dashboardState = computed(() => {
  if (isStreaming.value) return 'responding';
  if (isWaitingForResponse.value) return 'thinking';
  return 'idle';
});

const particleCount = computed(() => 
  Math.floor(20 * reactiveStore.particleActivity.value)
);

watch(dashboardState, (newState) => {
  reactiveStore.transitionToState(newState);
  
  // Adjust mood based on activity
  if (newState === 'thinking') {
    reactiveStore.setMoodState('contemplative');
  } else if (newState === 'responding') {
    reactiveStore.setMoodState('engaged');
  }
});

function selectAgent(agent) {
  activeAgentId.value = agent.id;
  
  // Trigger selection effects
  reactiveStore.triggerGlowBurst(0.8, 600);
  reactiveStore.triggerRipple({
    duration: 1000,
    intensity: 0.7,
    count: 2
  });
  
  // Change mood based on agent type
  if (agent.type === 'creative') {
    reactiveStore.setMoodState('excited');
  } else if (agent.type === 'analytical') {
    reactiveStore.setMoodState('contemplative');
  }
}

function handleNewMessage(message) {
  messages.value.push(message);
  
  if (message.role === 'user') {
    isWaitingForResponse.value = true;
    reactiveStore.transitionToState('thinking');
  }
}

function getParticleStyle(index) {
  return {
    '--particle-delay': `${index * 0.1}s`,
    '--particle-duration': `${20 + Math.random() * 10}s`,
    '--particle-x': `${Math.random() * 100}%`,
    '--particle-y': `${Math.random() * 100}%`,
  };
}
</script>
```

## Troubleshooting

### Common Issues

#### 1. Effects Not Appearing

**Problem**: Reactive effects aren't visible despite correct classes.

**Solutions**:
- Check if CSS variables are applied to root element
- Verify reactive store is initialized
- Ensure SCSS files are imported correctly
- Check browser console for CSS errors

```typescript
// Debug CSS variables
console.log(reactiveStore.cssVariables.value);

// Check current state
console.log(reactiveStore.appState.value);
```

#### 2. Performance Issues

**Problem**: Animations are janky or slow.

**Solutions**:
- Enable mobile optimization classes
- Reduce particle count
- Use `will-change` CSS property sparingly
- Throttle state transitions

```html
<!-- Mobile optimized -->
<div class="reactive-element reactive-mobile-optimize">
  <!-- Content -->
</div>
```

```typescript
// Throttle transitions
import { throttle } from 'lodash';

const throttledTransition = throttle((state) => {
  reactiveStore.transitionToState(state);
}, 500);
```

#### 3. Effects Persist After State Change

**Problem**: Visual effects don't clear when changing states.

**Solution**: Ensure proper cleanup in state transitions:

```typescript
// Manual cleanup if needed
reactiveStore.reset();

// Or remove specific effects
reactiveStore.removeEffect('ripple');
reactiveStore.removeEffect('glow');
```

#### 4. Theme Conflicts

**Problem**: Effects don't match theme colors.

**Solution**: Ensure theme is initialized before reactive system:

```typescript
// Correct order
await uiStore.initializeTheme();
reactiveStore.transitionToState('idle');
```

### Debug Mode

Enable debug mode to visualize reactive states:

```html
<!-- Show state indicator -->
<div class="debug-reactive" :data-reactive-state="currentState">
  <!-- Content -->
</div>

<!-- Show reactive values -->
<div class="show-reactive-values">
  <!-- Shows intensity and glow values -->
</div>
```

### Browser Compatibility

- **Chrome/Edge**: Full support
- **Firefox**: Full support (custom scrollbar fallback)
- **Safari**: Full support (some blur effects may vary)
- **Mobile**: Automatically optimized

### Performance Metrics

Target performance goals:
- State transitions: < 16ms per frame (60fps)
- Effect triggers: < 5ms execution time
- Memory usage: < 10MB for particle systems
- CSS paint time: < 10ms

## Contributing

When adding new states or effects:

1. **Update Types**
```typescript
// In reactive.store.ts
export type AppState = '...' | 'your-new-state';
```

2. **Add State Config**
```typescript
const stateConfigs = {
  'your-new-state': {
    intensity: 0.7,
    pulseRate: 0.6,
    // ... other parameters
  }
};
```

3. **Create SCSS Effects**
```scss
// In _reactive-effects-mixins.scss
@else if $state == 'your-new-state' {
  // Your custom effects
}
```

4. **Document Usage**
```markdown
### your-new-state
Description and usage examples
```

## Resources

- [GSAP Documentation](https://greensock.com/docs/)
- [Vue 3 Composition API](https://vuejs.org/guide/composition-api)
- [CSS Custom Properties](https://developer.mozilla.org/en-US/docs/Web/CSS/--*)
- [Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API)

## License

This reactive state system is part of the Voice Chat Assistant project and follows the project's licensing terms.