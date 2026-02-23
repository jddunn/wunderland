import { describe, it, expect } from 'vitest';

import { KeybindingManager } from '../cli/tui/keybindings.js';
import type { KeypressEvent } from '../cli/tui/screen.js';

function keypress(overrides: Partial<KeypressEvent>): KeypressEvent {
  return {
    name: '',
    sequence: '',
    ctrl: false,
    meta: false,
    shift: false,
    ...overrides,
  };
}

describe('TUI KeybindingManager', () => {
  it('routes deferred shortcut keys to __text__ in the same layer', () => {
    const keys = new KeybindingManager();

    let typed = '';
    keys.push({
      name: 'layer',
      bindings: {
        d: () => false, // defer to text input when focused
        '__text__': (key) => {
          typed += key.sequence;
          return true;
        },
      },
    });

    const handled = keys.handle(keypress({ name: '', sequence: 'd' }));
    expect(handled).toBe(true);
    expect(typed).toBe('d');
  });

  it('does not fall through to lower layers when __text__ handles', () => {
    const keys = new KeybindingManager();

    let rootHit = 0;
    keys.push({
      name: 'root',
      bindings: {
        d: () => { rootHit++; },
      },
    });

    let typed = '';
    keys.push({
      name: 'top',
      bindings: {
        d: () => false,
        '__text__': (key) => {
          typed += key.sequence;
          return true;
        },
      },
    });

    keys.handle(keypress({ name: '', sequence: 'd' }));

    expect(rootHit).toBe(0);
    expect(typed).toBe('d');
  });

  it('treats space as printable text', () => {
    const keys = new KeybindingManager();

    let typed = '';
    keys.push({
      name: 'layer',
      bindings: {
        '__text__': (key) => {
          typed += key.sequence;
          return true;
        },
      },
    });

    keys.handle(keypress({ name: 'space', sequence: ' ' }));
    expect(typed).toBe(' ');
  });

  it('supports __any__ to consume non-text keys', () => {
    const keys = new KeybindingManager();

    let anyHits = 0;
    keys.push({
      name: 'overlay',
      bindings: {
        '__any__': () => { anyHits++; return true; },
      },
    });

    const handled = keys.handle(keypress({ name: 'up', sequence: '' }));
    expect(handled).toBe(true);
    expect(anyHits).toBe(1);
  });
});
