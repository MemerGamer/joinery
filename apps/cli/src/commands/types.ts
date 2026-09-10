/** Shared shape for every command module (SPEC §10: one per CLI command). */
export interface Command {
  /** e.g. "reading-order set" — used in help and error messages. */
  readonly path: string;
  readonly summary: string;
  readonly usage: string;
  run(argv: readonly string[]): Promise<void>;
}
