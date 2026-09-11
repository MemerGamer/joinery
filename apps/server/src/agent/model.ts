/**
 * The Claude model used for agent runs (§9). A named constant so it's a
 * one-line change later — never inline the literal elsewhere.
 *
 * Haiku, deliberately: reading-order generation runs on every "Generate
 * reading order" click, so it should be cheap to iterate on while testing.
 * Do not append a date suffix to this id.
 */
export const AGENT_MODEL_ID = 'claude-haiku-4-5';
