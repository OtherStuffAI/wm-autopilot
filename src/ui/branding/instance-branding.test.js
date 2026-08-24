import { describe, expect, test } from 'bun:test';

import {
  getInstanceName,
  normalizeBrandColorInput,
  normalizeInstanceBranding,
} from './instance-branding.js';

describe('instance branding', () => {
  test('normalizes configured instance branding', () => {
    expect(normalizeInstanceBranding({ name: ' Example Agent ', highlightColor: '#A855F7' })).toEqual({
      name: 'Example Agent',
      highlightColor: '#a855f7',
    });
  });

  test('uses safe defaults for missing or invalid values', () => {
    expect(normalizeInstanceBranding({ name: ' ', highlightColor: 'green' })).toEqual({
      name: 'Wingman',
      highlightColor: '#10b981',
    });
    expect(getInstanceName(null)).toBe('Wingman');
  });

  test('normalizes directly typed hex colours', () => {
    expect(normalizeBrandColorInput('A855F7')).toBe('#a855f7');
    expect(normalizeBrandColorInput(' #2563eb ')).toBe('#2563eb');
    expect(normalizeBrandColorInput('#12345')).toBeNull();
    expect(normalizeBrandColorInput('blue')).toBeNull();
  });

  test('does not leave legacy green shades in themed UI effects', async () => {
    const styles = await Bun.file(new URL('../styles.css', import.meta.url)).text();
    expect(styles).not.toMatch(/#(?:34d399|6ee7b7|d1fae5|ecfdf5)/i);
    expect(styles).not.toMatch(/rgba\((?:52, 211, 153|110, 231, 183),/);
  });
});
