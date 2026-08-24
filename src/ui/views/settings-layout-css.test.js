import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('Settings route layout', () => {
  test('uses a route-scoped full-width canvas without changing the default app width', () => {
    expect(styles).toMatch(/#app\s*\{[\s\S]*?max-width:\s*1080px;/);
    expect(styles).toMatch(/#app\[data-route="settings"\]\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*padding:\s*0;/);
  });

  test('keeps the desktop rail stable and bounds only the main settings content', () => {
    expect(styles).toMatch(/\.wm-settings-shell\s*\{[^}]*grid-template-columns:\s*15\.25rem minmax\(0, 1fr\);[^}]*gap:\s*0;/);
    expect(styles).toMatch(/\.wm-settings-nav\s*\{[^}]*border-right:\s*1px solid var\(--border\);/);
    expect(styles).toMatch(/\.wm-settings-shell__content\s*\{[^}]*max-width:\s*74\.375rem;[^}]*margin:\s*0 auto;/);
  });

  test('provides responsive content grids for populated Settings pages', () => {
    expect(styles).toMatch(/\.wm-settings-grid\s*\{[^}]*display:\s*grid;[^}]*repeat\(auto-fit,/);
    expect(styles).toMatch(/\.wm-settings-grid--credentials\s*\{[^}]*min\(100%, 19rem\)/);
    expect(styles).toMatch(/\.wm-settings-grid--hosting-boundary,[\s\S]*?min\(100%, 25rem\)/);
    expect(styles).toMatch(/\.wm-settings-grid--access\s*>\s*\.wm-admin-users--listing\s*\{[^}]*grid-row:\s*span 2;/);
  });

  test('collapses to the existing mobile picker and removes desktop canvas spacing', () => {
    const mobileRules = styles.slice(styles.indexOf('@media (max-width: 850px)'));
    expect(mobileRules).toMatch(/\.wm-settings-nav\s*\{\s*display:\s*none;/);
    expect(mobileRules).toMatch(/\.wm-settings-mobile-nav\s*\{[^}]*display:\s*flex;/);
    expect(mobileRules).toMatch(/\.wm-settings-shell__content\s*\{[^}]*padding:\s*0;/);
    expect(mobileRules).toMatch(/\.wm-settings-grid--access\s*>\s*\.wm-admin-users--listing\s*\{[^}]*grid-row:\s*auto;/);
  });
});
