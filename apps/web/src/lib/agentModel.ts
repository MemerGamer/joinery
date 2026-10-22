/**
 * Remembered model picks, kept across reloads.
 *
 * - The Ask pick: one choice shared by every "Ask" button (composer and
 *   thread card), so picking Opus once means the next Ask uses Opus too.
 * - The generation pick: the model the last reading order was generated
 *   with, shared by the reading-order pane's "Generate with" button and the
 *   command palette's generate page. Null until a first generation.
 */
import { agentModelSchema, DEFAULT_AGENT_MODEL, type AgentModel } from '@joinery/core';
import { useSyncExternalStore } from 'react';

function modelStore<T extends AgentModel | null>(key: string, fallback: T) {
  const listeners = new Set<() => void>();

  let current: AgentModel | T = fallback;
  try {
    const parsed = agentModelSchema.safeParse(localStorage.getItem(key));
    if (parsed.success) current = parsed.data;
  } catch {
    // No storage: start from the fallback.
  }

  const get = (): AgentModel | T => current;

  const set = (model: AgentModel): void => {
    current = model;
    try {
      localStorage.setItem(key, model);
    } catch {
      // Best-effort only.
    }
    for (const l of listeners) l();
  };

  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };

  const use = (): AgentModel | T => useSyncExternalStore(subscribe, get);

  return { get, set, use };
}

const askModel = modelStore('joinery:agent-model', DEFAULT_AGENT_MODEL);

/** The current Ask pick, for request bodies built outside React. */
export const getAgentModel: () => AgentModel = askModel.get;
export const setAgentModel: (model: AgentModel) => void = askModel.set;
export const useAgentModel: () => AgentModel = askModel.use;

const generationModel = modelStore('joinery:generation-model', null);

/** The model the last reading order was generated with; null before the first. */
export const getGenerationModel: () => AgentModel | null = generationModel.get;
export const setGenerationModel: (model: AgentModel) => void = generationModel.set;
export const useGenerationModel: () => AgentModel | null = generationModel.use;
