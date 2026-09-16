import type { AppConfig } from './types';

/**
 * Runtime config contract: /config.json is written by the deploy workflow
 * (CloudFront serves it same-origin next to the SPA).
 *
 *   { "region": "us-west-2", "userPoolId": "us-west-2_xxxx", "userPoolClientId": "abc123" }
 *
 * Fallback: if the file is missing or fields are blank, the auth screens
 * render a "not configured" notice instead of crashing. No secrets ever
 * live here — these are public client identifiers.
 */

const PLACEHOLDER: AppConfig = { region: '', userPoolId: '', userPoolClientId: '' };

let cached: Promise<AppConfig> | null = null;

export function loadConfig(): Promise<AppConfig> {
  if (!cached) {
    cached = fetch('/config.json', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return PLACEHOLDER;
        const raw = (await res.json()) as Partial<AppConfig>;
        return {
          region: raw.region ?? '',
          userPoolId: raw.userPoolId ?? '',
          userPoolClientId: raw.userPoolClientId ?? '',
        };
      })
      .catch(() => PLACEHOLDER);
  }
  return cached;
}

export function isConfigured(cfg: AppConfig): boolean {
  return cfg.userPoolId !== '' && cfg.userPoolClientId !== '';
}
