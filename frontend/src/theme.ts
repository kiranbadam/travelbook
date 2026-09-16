import { defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

/**
 * TravelBook brand theme.
 *
 * Base: Astryx Neutral (warm grays, system fonts, Lucide icons). Brand delta:
 * a deep-sea teal accent — light mode `#0B7A64`, dark mode `#3FD6A4` — seeded
 * through `color.accent` so the full derived accent ramp (muted, text, icon
 * tokens) regenerates per scheme instead of overriding a single token.
 *
 * Light/dark surfaces come from the base theme's onLight/onDark surfaces;
 * the <Theme> provider's `mode` prop flips them. The prebuilt
 * `@astryxdesign/theme-neutral/theme.css` (imported in index.css) supplies
 * the base tokens; this theme injects only the brand delta at runtime.
 */
export const travelBookTheme = defineTheme({
  name: 'travelbook',
  extends: neutralTheme,
  color: {
    accent: ['#0B7A64', '#3FD6A4'],
    neutralStyle: 'warm',
  },
});
