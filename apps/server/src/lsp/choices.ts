/**
 * Which language server each language uses, as chosen in Settings: stored in
 * `app_setting` (`lsp.choice.<language>`), held in memory so starting a
 * server never waits on the database. Nothing chosen means the default:
 * Joinery's copy of the language's default server where this platform has a
 * build of it, else off.
 */
import { existsSync, statSync } from 'node:fs';
import { LSP_SERVERS, lspChoiceSchema, type LspChoice, type LspLanguage } from '@joinery/core';
import { getAppSetting, putAppSetting, type Db } from '../db/index.ts';
import { installableFor } from './install.ts';

const choices = new Map<LspLanguage, LspChoice>();

const keyOf = (language: LspLanguage) => `lsp.choice.${language}`;

/** Reads every language's choice; once at startup. A stored value that no longer parses counts as unset. */
export async function loadLspChoices(db: Db): Promise<void> {
  for (const language of Object.keys(LSP_SERVERS) as LspLanguage[]) {
    const parsed = lspChoiceSchema.safeParse(await getAppSetting(db, keyOf(language)));
    if (parsed.success) choices.set(language, parsed.data);
  }
}

export function lspChoice(language: LspLanguage): LspChoice {
  return choices.get(language) ?? (installableFor(language) !== null ? { source: 'managed' } : { source: 'off' });
}

/** Why `choice` can't be made for `language`, or null when it can be saved. */
export function invalidChoice(language: LspLanguage, choice: LspChoice): string | null {
  if (choice.source === 'off') return null;
  if (choice.source === 'managed') {
    return installableFor(language) !== null ? null : `No ${language} language server build for this machine; set a custom path`;
  }
  if (!LSP_SERVERS[language].includes(choice.server)) return `${choice.server} is not a ${language} language server`;
  if (!existsSync(choice.path)) return `Nothing at ${choice.path}`;
  if (!statSync(choice.path).isFile()) return `${choice.path} is not a file`;
  return null;
}

export async function saveLspChoice(db: Db, language: LspLanguage, choice: LspChoice): Promise<void> {
  await putAppSetting(db, keyOf(language), choice);
  choices.set(language, choice);
}
