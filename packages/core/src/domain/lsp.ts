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

/** The servers Settings can install itself, into Joinery's data directory. */
export const installableServerSchema = lspServerIdSchema.extract(['tsrs', 'phpantom']);
export type InstallableServer = z.infer<typeof installableServerSchema>;

/**
 * A file the language features can show: `ref` names it in later requests
 * (the `path` of a query) — the repo-relative path for a file in the review's
 * checkout, or `external:<id>` for one outside it that the server pointed to
 * (a dependency's real path, TypeScript's lib files). `path` is for display:
 * repo-relative, or absolute (`~`-shortened) when external.
 */
const lspFileFields = {
  ref: z.string(),
  path: z.string(),
  /** Outside the checkout: a dependency, a stub, the standard library. */
  external: z.boolean(),
  /** A file this review changes, so the diff can jump to it. */
  inReview: z.boolean(),
};

export const lspPositionQuerySchema = z.object({
  /** A file in the diff, any file in the review's checkout, or a `ref` from an earlier answer. */
  path: z.string().min(1),
  line: z.coerce.number().int().positive(),
  character: z.coerce.number().int().nonnegative(),
});
export type LspPositionQuery = z.infer<typeof lspPositionQuerySchema>;

export const lspFileQuerySchema = z.object({ path: z.string().min(1) });

export const lspHoverSchema = z.object({
  /** Signature and docblock, as markdown (code fences carry the language). */
  markdown: z.string(),
  server: lspServerIdSchema,
});
export type LspHover = z.infer<typeof lspHoverSchema>;

export const lspFileSchema = z.object({
  ...lspFileFields,
  /** The file's text from its first line: all of it, unless `truncated`. */
  text: z.string(),
  /** A very large file, cut off (a little after the definition, for one). */
  truncated: z.boolean(),
});
export type LspFile = z.infer<typeof lspFileSchema>;

export const lspDefinitionSchema = lspFileSchema.extend({
  /** 1-based line the definition's name is on. */
  line: z.number().int().positive(),
  server: lspServerIdSchema,
});
export type LspDefinition = z.infer<typeof lspDefinitionSchema>;

export const lspReferenceSchema = z.object({
  ...lspFileFields,
  /** 1-based line and 0-based UTF-16 character of the use. */
  line: z.number().int().positive(),
  character: z.number().int().nonnegative(),
  /** The line's text, trimmed. */
  preview: z.string(),
});
export type LspReference = z.infer<typeof lspReferenceSchema>;

export const lspReferencesSchema = z.object({
  /** Files this review changes first, then by path and line. */
  references: z.array(lspReferenceSchema),
  /** More were found than are listed. */
  truncated: z.boolean(),
  server: lspServerIdSchema,
});
export type LspReferences = z.infer<typeof lspReferencesSchema>;
