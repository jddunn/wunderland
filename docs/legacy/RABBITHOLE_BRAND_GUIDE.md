# Rabbit Hole Inc - Brand Guide

Complete branding specifications for Rabbit Hole Inc.

## Logo

### Primary Logo

The primary logo consists of:
1. **Icon**: Keyhole with rabbit silhouette (champagne gold gradient)
2. **Wordmark**: "RABBIT HOLE" in Cormorant Garamond 600
3. **Subtext**: "INC" in Tenor Sans 400
4. **Tagline**: Optional (e.g., "FOUNDER'S CLUB") in Tenor Sans 400

### Logo Variants

| Variant | Components | Usage |
|---------|------------|-------|
| `full` | Icon + wordmark + tagline | Footer, marketing materials |
| `compact` | Icon + wordmark | Navigation, headers |
| `icon` | Icon only | Favicon, small spaces |
| `wordmark` | Text only | Co-branding |

### Logo Sizes

| Size | Icon | Primary Text | Usage |
|------|------|--------------|-------|
| `sm` | 32px | 1rem | Navigation bars |
| `md` | 48px | 1.5rem | Page headers |
| `lg` | 64px | 2rem | Hero sections |

### Clear Space

Maintain clear space equal to the icon height on all sides of the logo.

### Minimum Sizes

- Full logo: 200px width minimum
- Icon only: 16px minimum

## Color Palette

### Primary - Champagne Gold

The signature gold gradient represents premium quality and exclusivity.

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| Gold | `#c9a227` | 201, 162, 39 | Primary brand color |
| Gold Light | `#e8d48a` | 232, 212, 138 | Highlights, gradients |
| Gold Dark | `#8b6914` | 139, 105, 20 | Shadows, gradients |

**Gold Gradient**: `linear-gradient(135deg, #8b6914 0%, #c9a227 25%, #e8d48a 50%, #c9a227 75%, #8b6914 100%)`

### Secondary - Obsidian

Deep, sophisticated dark tones for backgrounds and contrast.

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| Obsidian | `#1a1625` | 26, 22, 37 | Primary dark |
| Obsidian Mid | `#12101a` | 18, 16, 26 | Darker backgrounds |
| Obsidian Deep | `#08050a` | 8, 5, 10 | Deepest backgrounds |

### Neutral - Cream

Warm, inviting tones for light backgrounds and inner elements.

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| Cream | `#f8f6f2` | 248, 246, 242 | Light backgrounds |
| Warm White | `#f5f0e8` | 245, 240, 232 | Warmer backgrounds |

### CSS Variables

```scss
// Rabbit Hole Brand Colors
$rh-gold: #c9a227;
$rh-gold-light: #e8d48a;
$rh-gold-dark: #8b6914;
$rh-obsidian: #1a1625;
$rh-obsidian-deep: #08050a;
$rh-obsidian-mid: #12101a;
$rh-cream: #f8f6f2;
$rh-warm: #f5f0e8;

// CSS Custom Properties
:root {
  --rh-gold: #c9a227;
  --rh-gold-light: #e8d48a;
  --rh-gold-dark: #8b6914;
  --rh-obsidian: #1a1625;
  --rh-obsidian-deep: #08050a;
  --rh-obsidian-mid: #12101a;
  --rh-cream: #f8f6f2;
  --rh-warm: #f5f0e8;
}
```

## Typography

### Display Font - Cormorant Garamond

Used for the logo wordmark and premium headlines.

- **Weight**: 600 (Semi-Bold)
- **Letter Spacing**: 0.12em
- **Style**: Uppercase

```css
font-family: 'Cormorant Garamond', Georgia, serif;
font-weight: 600;
letter-spacing: 0.12em;
text-transform: uppercase;
```

### Body Font - Tenor Sans

Used for taglines, subtitles, and secondary text.

- **Weight**: 400 (Regular)
- **Letter Spacing**: 0.2em
- **Style**: Uppercase for taglines

```css
font-family: 'Tenor Sans', 'Helvetica Neue', sans-serif;
font-weight: 400;
letter-spacing: 0.2em;
text-transform: uppercase;
```

### Google Fonts Import

```html
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Tenor+Sans&display=swap" rel="stylesheet">
```

## Favicon

### Specifications

The favicon uses the keyhole icon with rabbit silhouette in champagne gold.

| Format | Size | Usage |
|--------|------|-------|
| favicon.ico | 16x16, 32x32, 48x48 | Browser tabs |
| icon.svg | Scalable | Modern browsers |
| apple-touch-icon.png | 180x180 | iOS home screen |
| icon-192.png | 192x192 | PWA |
| icon-512.png | 512x512 | PWA splash |

### Theme Color

```html
<meta name="theme-color" content="#c9a227">
```

## Component Usage

### React Components

```tsx
import { RabbitHoleLogo, Footer, KeyholeIcon } from '@/components/brand';

// Navigation logo
<RabbitHoleLogo variant="compact" size="sm" href="/" />

// Full logo with tagline
<RabbitHoleLogo
  variant="full"
  tagline="FOUNDER'S CLUB"
  size="md"
/>

// Icon only
<KeyholeIcon size={48} />

// Footer
<Footer tagline="FOUNDER'S CLUB" />
```

### Props Reference

#### RabbitHoleLogo

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'full' \| 'compact' \| 'icon' \| 'wordmark'` | `'full'` | Logo variant |
| `showTagline` | `boolean` | `true` | Show tagline (full variant only) |
| `tagline` | `string` | `"FOUNDER'S CLUB"` | Tagline text |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Size preset |
| `href` | `string` | - | Makes logo a link |
| `className` | `string` | - | Additional CSS classes |

#### KeyholeIcon

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `number` | `64` | Icon size in pixels |
| `className` | `string` | - | Additional CSS classes |
| `id` | `string` | `'keyhole'` | Unique ID for gradients |

#### Footer

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `tagline` | `string` | `"FOUNDER'S CLUB"` | Logo tagline |
| `links` | `FooterLink[]` | Default links | Navigation links |
| `copyright` | `string` | Current year | Copyright text |
| `className` | `string` | - | Additional CSS classes |

## Usage Guidelines

### Do

- Use the gold logo on dark backgrounds
- Maintain clear space around the logo
- Use official color palette
- Use proper font weights and spacing

### Don't

- Stretch or distort the logo
- Use unapproved colors
- Place logo on busy backgrounds
- Modify the icon proportions

### Background Pairing

| Background | Logo Color |
|------------|------------|
| Dark (#030305 - #1a1625) | Gold gradient |
| Light (#f8f6f2 - #ffffff) | Gold gradient |

The gold gradient works on both light and dark backgrounds, providing visual continuity across the brand.

## Print Specifications

For premium print applications:
- **Paper**: Cream stock (closest to #f8f6f2)
- **Finish**: Emboss or foil stamp
- **Minimum size**: 200px width equivalent

## File Locations

```
apps/rabbithole/
├── src/components/brand/
│   ├── KeyholeIcon.tsx       # SVG icon component
│   ├── RabbitHoleLogo.tsx    # Full logo component
│   ├── Footer.tsx            # Branded footer
│   └── index.ts              # Barrel export
├── public/
│   ├── icon.svg              # Scalable favicon
│   ├── manifest.json         # PWA manifest
│   └── favicon.ico           # Browser favicon
└── brand.html                # Logo export system
```
