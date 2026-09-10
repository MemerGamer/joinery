/**
 * Narrowing helpers for the string-union columns (`current_revision`,
 * `status`, `side`, `author`, `kind`, ...). SQLite stores them as plain
 * `text`, so drizzle infers `string` for those columns; these helpers assert
 * membership in the zod-validated union at the boundary instead of casting
 * with `as`. Throwing here means "the database contains a value nothing in
 * this codebase could have written" rather than silently mistyping it.
 */
export function narrowUnion<const T extends readonly string[]>(
  value: string,
  allowed: T,
  context: string,
): T[number] {
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`${context}: unexpected value ${JSON.stringify(value)}, expected one of ${allowed.join(', ')}`);
}
