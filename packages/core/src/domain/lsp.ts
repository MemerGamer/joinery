import { z } from 'zod';

/**
 * Language intelligence in the diff: hover and peek-definition, answered by a
 * language server the server runs against the review's checkout.
 *
 * Positions are the head side of the review's current revision: `line` is
 * 1-based like the diff's line numbers, `character` is a 0-based UTF-16
 * offset into that line (what LSP and JavaScript strings both use).
 */
export const lspLanguageSchema = z.enum(['typescript', 'php']);
export type LspLanguage = z.infer<typeof lspLanguageSchema>;

export const lspServerIdSchema = z.enum([
  'tsrs',
  'tsgo',
  'typescript-language-server',
  'phpantom',
  'intelephense',
  'phpactor',
]);
export type LspServerId = z.infer<typeof lspServerIdSchema>;

export const lspPositionQuerySchema = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int().positive(),
  character: z.coerce.number().int().nonnegative(),
});
export type LspPositionQuery = z.infer<typeof lspPositionQuerySchema>;

export const lspHoverSchema = z.object({
  /** Signature and docblock, as markdown (code fences carry the language). */
  markdown: z.string(),
  server: lspServerIdSchema,
});
export type LspHover = z.infer<typeof lspHoverSchema>;

export const lspDefinitionSchema = z.object({
  /** Repo-relative when inside the checkout; otherwise absolute (`~`-shortened). */
  path: z.string(),
  /** Outside the checkout: a dependency, a stub, the standard library. */
  external: z.boolean(),
  /** 1-based line the definition's name is on. */
  line: z.number().int().positive(),
  /** 1-based line `snippet` starts at. */
  startLine: z.number().int().positive(),
  snippet: z.string(),
  /** The definition is in a file this review changes, so the diff can jump to it. */
  inReview: z.boolean(),
  server: lspServerIdSchema,
});
export type LspDefinition = z.infer<typeof lspDefinitionSchema>;
