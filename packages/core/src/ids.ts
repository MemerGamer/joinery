/**
 * Ids are opaque strings everywhere in the contract. These helpers exist so the
 * server mints them one way and tests can assert the shape.
 */
export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`;

export const reviewId = (): string => newId('rev');
export const threadId = (): string => newId('thr');
export const commentId = (): string => newId('cmt');
export const runId = (): string => newId('run');
export const repoId = (): string => newId('repo');
export const readingOrderId = (): string => newId('ro');
export const stepId = (): string => newId('step');
