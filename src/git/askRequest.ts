import { Git } from '@jupyterlab/git';
import type { TranslationBundle } from '@jupyterlab/translation';
import type { SelectedLineRange } from '@pierre/diffs';

import type { IAskAgentRequest } from '../askAgent/tokens';

import type { IXtralabDiffModel } from './diffWidget';

type DiffSide = 'deletions' | 'additions';

/**
 * Agent-facing name of a diff content source: the special refs get plain
 * words, a git ref string is used verbatim, anything else falls back to the
 * side name. English on purpose — this ends up in the agent prompt, not in
 * the UI.
 */
function describeSource(source: unknown, fallback: string): string {
  if (source === Git.Diff.SpecialRef.WORKING) {
    return 'working tree';
  }
  if (source === Git.Diff.SpecialRef.INDEX) {
    return 'staged';
  }
  if (source === Git.Diff.SpecialRef.BASE) {
    return 'merge base';
  }
  if (typeof source === 'string' && source.length > 0) {
    return source;
  }
  return fallback;
}

function sideName(side: DiffSide): string {
  return side === 'deletions' ? 'old side' : 'new side';
}

/**
 * Extract lines `startLine`–`endLine` (1-indexed, inclusive) from `text`.
 */
function sliceLines(text: string, startLine: number, endLine: number): string {
  return text
    .split('\n')
    .slice(startLine - 1, endLine)
    .join('\n');
}

/**
 * Build the ask-agent request for a line range selected in a git diff.
 *
 * The range's `side` decides which file version the line numbers (and the
 * embedded snippet) refer to: `deletions` reads from the reference text,
 * anything else — including the sideless context rows of a unified diff,
 * whose gutter shows new-side numbers — reads from the challenger text. A
 * gutter drag that crosses the two split columns has endpoints in different
 * line-number spaces, so it is described textually instead of as a numeric
 * range.
 */
export function buildDiffAskRequest(options: {
  model: IXtralabDiffModel;
  oldText: string;
  newText: string;
  range: SelectedLineRange;
  anchor: DOMRect | null;
  trans: TranslationBundle;
}): IAskAgentRequest {
  const { model, oldText, newText, range, anchor, trans } = options;
  const repositoryPath = model.repositoryPath ?? '';
  const base = {
    path: model.filename,
    ...(repositoryPath.length > 0 ? { cwd: repositoryPath } : {})
  };

  const startSide: DiffSide = range.side ?? 'additions';
  const endSide: DiffSide = range.endSide ?? startSide;

  if (startSide !== endSide) {
    return {
      context: {
        ...base,
        text: '',
        location:
          `lines ${range.start} (${sideName(startSide)}) through ` +
          `${range.end} (${sideName(endSide)}) of the current git diff`,
        note: trans.__('diff selection')
      },
      anchor
    };
  }

  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  const isOld = startSide === 'deletions';
  const source = isOld ? model.reference.source : model.challenger.source;
  const ref = describeSource(source, isOld ? 'old' : 'new');
  return {
    context: {
      ...base,
      startLine,
      endLine,
      // Only new-side lines of a working-tree diff index the file on disk;
      // old-side and historical line numbers must not be used to highlight
      // the working file.
      linesInWorkingFile:
        !isOld && model.challenger.source === Git.Diff.SpecialRef.WORKING,
      text: sliceLines(isOld ? oldText : newText, startLine, endLine),
      location: `the ${sideName(startSide)} (${ref}) of the current git diff`,
      note: isOld ? trans.__('old side') : trans.__('new side')
    },
    anchor
  };
}
