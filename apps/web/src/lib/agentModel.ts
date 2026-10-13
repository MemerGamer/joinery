/**
 * The model picked for thread replies — one choice shared by every "Ask"
 * button (composer and thread card) and remembered across reloads, so
 * picking Opus once means the next Ask uses Opus too.
 */
import { agentModelSchema, DEFAULT_AGENT_MODEL, type AgentModel } from '@joinery/core';
import { useSyncExternalStore } from 'react';

const KEY = 'joinery:agent-model';
const listeners = new Set<() => void>();

function load(): AgentModel {
  try {
    const parsed = agentModelSchema.safeParse(localStorage.getItem(KEY));
    return parsed.success ? parsed.data : DEFAULT_AGENT_MODEL;
  } catch {
    return DEFAULT_AGENT_MODEL;
  }
}

let current = load();

/** The current pick, for request bodies built outside React. */
export function getAgentModel(): AgentModel {
  return current;
}

export function setAgentModel(model: AgentModel): void {
  current = model;
  try {
    localStorage.setItem(KEY, model);
  } catch {
    // Best-effort only.
  }
  for (const l of listeners) l();
}

export function useAgentModel(): AgentModel {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getAgentModel,
  );
}
