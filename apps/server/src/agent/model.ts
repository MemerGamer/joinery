import { DEFAULT_AGENT_MODEL, type AgentModel } from '@review/core';

/**
 * The Claude model used for thread replies when the request names none.
 * Replies normally carry the model picked in the composer; this is
 * the fallback, and matches the picker's default.
 * Do not append a date suffix to this id.
 */
export const AGENT_MODEL_ID: AgentModel = DEFAULT_AGENT_MODEL;

/** The model for reading-order generation, which has no picker. Haiku: it runs on every "Generate reading order" click. */
export const READING_ORDER_MODEL_ID = 'claude-haiku-5-5';
