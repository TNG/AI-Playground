# Visual Changes Description

## Overview
This document describes the visual changes made to the AI Playground UI for distinguishing user-added models from predefined models.

## Before and After

### Model Selector Dropdown - BEFORE
```
┌────────────────────────────────────────┐
│ Model                                  │
├────────────────────────────────────────┤
│ ○ Llama-3.2-3B-Instruct-Q4_K_S.gguf ⓘ │
│ ● Meta-Llama-3.1-8B-Instruct-Q5_K_S.g ⓘ│  (active/downloaded)
│ ○ SmolLM2-1.7B-Instruct-q4_k_m.gguf  ⓘ │
│ ○ my-custom-model.gguf               ⓘ │  (user-added, no indicator)
└────────────────────────────────────────┘
```

### Model Selector Dropdown - AFTER
```
┌────────────────────────────────────────┐
│ Model                                  │
├────────────────────────────────────────┤
│ ○ Llama-3.2-3B-Instruct-Q4_K_S.gguf ⓘ │
│ ● Meta-Llama-3.1-8B-Instruct-Q5_K_S.g ⓘ│  (active/downloaded)
│ ○ SmolLM2-1.7B-Instruct-q4_k_m.gguf  ⓘ │
│ ○ my-custom-model.gguf  [Custom] ⓘ     │  (user-added, NOW with badge)
└────────────────────────────────────────┘
```

### Selected Model Display - BEFORE
```
┌────────────────────────────────────────┐
│ ● my-custom-model.gguf            ⓘ ▼ │
└────────────────────────────────────────┘
```

### Selected Model Display - AFTER
```
┌────────────────────────────────────────┐
│ ● my-custom-model.gguf  [Custom]  ⓘ ▼ │
└────────────────────────────────────────┘
```

## Badge Styling
The "Custom" badge has the following styling:
- **Text**: "Custom" in 10px font, medium weight
- **Background**: Primary color with 20% opacity (`bg-primary/20`)
- **Text Color**: Primary color (`text-primary`)
- **Shape**: Rounded corners
- **Padding**: Small padding (1.5px horizontal, 0.5px vertical)
- **Tooltip**: Shows "User-added model" on hover

## Capabilities Tooltip Changes

### For Predefined Models - BEFORE and AFTER (unchanged)
```
┌─────────────────────────────────┐
│ Model Info                      │
│                                 │
│ Max Context Size: 128,000 tokens│
│                                 │
│ Capabilities                    │
│ ┌─────────────┐ ┌─────────────┐ │
│ │ Tool Calling│ │ Vision      │ │
│ └─────────────┘ └─────────────┘ │
└─────────────────────────────────┘
```

### For User-Added Models - BEFORE
```
┌─────────────────────────────────┐
│ Model Info                      │
│                                 │
│ Capabilities                    │
│ ┌─────────┐                     │
│ │Standard │                     │
│ └─────────┘                     │
└─────────────────────────────────┘
```

### For User-Added Models - AFTER
```
┌─────────────────────────────────┐
│ Model Info                      │
│                                 │
│ ⚠️ User-added model - capabilities│
│    may not be fully specified   │
│                                 │
│ Capabilities                    │
│ ┌─────────┐                     │
│ │Standard │                     │
│ └─────────┘                     │
└─────────────────────────────────┘
```

## Color Scheme
- **Badge Background**: Primary color with 20% opacity (typically blue/purple-ish depending on theme)
- **Badge Text**: Primary color (full opacity)
- **Warning Text**: Amber color (`text-amber-500` in light mode, `text-amber-400` in dark mode)
- **Warning Icon**: ⚠️ emoji

## Layout Considerations
- Badge is positioned between model name and info icon
- Badge shrinks to fit without wrapping
- Layout remains clean even with long model names (text truncation applies before badge)
- Badge aligns vertically with other elements (items-center class)

## Responsive Behavior
- Badge maintains visibility at all screen sizes
- Text remains readable (minimum 10px)
- Badge does not interfere with dropdown scrolling
- Tooltip appears on hover without layout shift

## Accessibility
- Tooltip provides additional context for screen readers
- Color contrast meets WCAG standards (primary color on light background)
- Warning message is clearly visible and readable
- Badge is optional visual indicator (functionality not dependent on seeing it)

## Theme Compatibility
- Badge adapts to light/dark themes via Tailwind's theme system
- Primary color follows application theme
- Amber warning color has both light and dark variants
- All colors defined using CSS custom properties

## Edge Cases Handled
- Empty model name: Badge still appears correctly
- Very long model names: Truncation applies before badge
- No capabilities: Shows "Standard" badge
- Multiple capability badges: Layout remains organized
- Mixed predefined/user-added lists: Clear visual distinction
