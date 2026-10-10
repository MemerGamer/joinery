/** Public surface of the branch state engine. */
export { ReviewEngine, type ReviewEngineParams } from './reviewEngine.ts';
export { EngineRegistry, type EventListener } from './registry.ts';
export { resolveRoot, type RootResolution } from './root.ts';
export { captureContext, hashContext, relocate, findSubsequence, CONTEXT_RADIUS } from './anchor.ts';
