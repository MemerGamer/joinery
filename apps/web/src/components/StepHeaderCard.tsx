/**
 * `renderCodeViewHeader` (SPEC §6): the current step's title + explanation,
 * non-virtualized and always in the DOM at the top of the scroll content.
 */
import type { Step } from '@review/core';
import { Markdown } from './Markdown.tsx';

export function StepHeaderCard({ step }: { step: Step | null }): React.JSX.Element {
  if (step === null) {
    return (
      <div className="mb-4 rounded-lg border border-dashed border-chrome-border p-4 text-sm text-chrome-fg-muted">
        No reading order yet. Generate one from the command palette or the CLI.
      </div>
    );
  }
  return (
    <div className="mb-4 rounded-lg border border-chrome-border bg-chrome-bg-raised p-4">
      <h2 className="text-sm font-medium text-chrome-fg">{step.title}</h2>
      {step.explanationMd.length > 0 && (
        <div className="mt-1.5">
          <Markdown>{step.explanationMd}</Markdown>
        </div>
      )}
    </div>
  );
}
