/**
 * Infra-owned Lambda entry shim.
 *
 * The real handler lives in backend/src/worker/index.ts (backend engineer's
 * domain). NodejsFunction requires its entry to sit under the infra project
 * root for local esbuild bundling, so this shim re-exports it. Keep the
 * exported `handler` name stable here and in the backend file.
 */
export * from '../../backend/src/worker/index';
