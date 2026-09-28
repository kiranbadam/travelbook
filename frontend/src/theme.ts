import { boldTheme } from './theme-bold/boldTheme';

/**
 * TravelBook brand theme — "Bold social" direction (chosen 2026-09-28).
 *
 * Base: scaffolded from the Astryx Y2K example theme via
 * `astryx theme add y2k`, then re-skinned as editable source in
 * `src/theme-bold/`: hot-pink accent, periwinkle body, bubbly radii,
 * heavy Poppins display type. See src/theme-bold/boldTheme.ts.
 *
 * The prebuilt `@astryxdesign/theme-neutral/theme.css` (imported in
 * index.css) supplies fallback base tokens; this theme injects the full
 * Bold token set at runtime via the <Theme> provider.
 */
export const travelBookTheme = boldTheme;
