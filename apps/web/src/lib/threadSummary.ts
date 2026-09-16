/**
 * One-line, plain-text preview of a markdown comment body, shared by the
 * collapsed thread row (ThreadArticle) and the threads panel list.
 *
 * Takes the first non-empty, non-fence line, strips the common inline
 * markup, and appends an ellipsis when the body has more content than that
 * one line. Width overflow is left to CSS `truncate`.
 */
export function threadSummary(md: string): string {
  const lines = md.split('\n').filter((l) => l.trim().length > 0 && !l.trim().startsWith('```'));
  const first = lines[0] ?? '';
  const text = first
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+|^\d+\.\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
  return lines.length > 1 ? `${text}…` : text;
}
