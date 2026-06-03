import { Git } from '@jupyterlab/git';
import { ISignal, Signal } from '@lumino/signaling';

import { content } from './api';
import type { IXtralabDiffModel } from './diffWidget';
import type { GitReference, IFileChange } from './tokens';

/**
 * Builds a `Git.Diff.IModel` from xtralab's own {@link IFileChange} status
 * row, so the launcher dashboard's "Changes" section can open diffs through
 * the very same widget the `jupyterlab-git` panel uses (see `diffWidget.tsx`).
 *
 * `jupyterlab-git` constructs its own models for the panel; this module is
 * the launcher-side adapter that produces an equivalent model from the
 * porcelain-derived change, fetching content through xtralab's REST helper.
 */

/**
 * Resolve the pair of git references whose `content` should appear on the
 * left and right side of the diff for a given file change. Mirrors VS Code's
 * source control diff: the staged side compares INDEX vs HEAD, the unstaged
 * side compares WORKING vs INDEX, and untracked files have no "previous"
 * version to compare against.
 */
export function resolveReferences(change: IFileChange): {
  oldRef: GitReference | null;
  newRef: GitReference | null;
} {
  if (change.status === 'untracked') {
    return { oldRef: null, newRef: { special: 'WORKING' } };
  }
  if (change.group === 'staged') {
    return { oldRef: { git: 'HEAD' }, newRef: { special: 'INDEX' } };
  }
  // Unstaged: WORKING vs INDEX. If the file isn't in the index yet (e.g. a
  // freshly-`git add`-ed file modified again) the server returns the HEAD
  // blob for INDEX, which is still the right baseline for the diff.
  return { oldRef: { special: 'INDEX' }, newRef: { special: 'WORKING' } };
}

/**
 * Map a {@link GitReference} onto the `source` marker carried by
 * `Git.Diff.IContent`. `null` means there is no baseline (an untracked file's
 * reference side). The working-tree marker has to be the real enum value
 * because it is what the shared diff view keys off when it derives hunk-discard
 * eligibility for `jupyterlab-git`'s own models.
 */
function referenceSource(ref: GitReference | null): unknown {
  if (ref === null) {
    return null;
  }
  if ('git' in ref) {
    return ref.git;
  }
  if (ref.special === 'WORKING') {
    return Git.Diff.SpecialRef.WORKING;
  }
  if (ref.special === 'INDEX') {
    return Git.Diff.SpecialRef.INDEX;
  }
  return Git.Diff.SpecialRef.BASE;
}

/**
 * A `Git.Diff.IModel` whose two sides are fetched through xtralab's `content`
 * REST helper at the references {@link resolveReferences} picks, carrying the
 * `isBinary` / `canDiscard` facts the bare interface cannot.
 */
class FileChangeDiffModel implements IXtralabDiffModel {
  constructor(repoPath: string, change: IFileChange) {
    const { oldRef, newRef } = resolveReferences(change);
    // Renames diff the new path against the *old* path's previous content.
    const oldName = change.from ?? change.path;
    this.filename = change.path;
    // Only set for renames (`change.from` is undefined otherwise); the old
    // side is then labelled / language-detected from its previous path.
    this.oldFilename = change.from;
    this.repositoryPath = repoPath;
    this.isBinary = change.isBinary === true;
    // Untracked files have no index/HEAD baseline to revert a hunk to, so
    // per-hunk discard is meaningless for them; every other unstaged change
    // is discardable. Staged changes compare INDEX vs HEAD and cannot be
    // un-done through the working-tree write that discard performs.
    this.canDiscard =
      change.group === 'unstaged' && change.status !== 'untracked';
    this.reference = {
      label: oldName,
      source: referenceSource(oldRef),
      content: () =>
        oldRef === null
          ? Promise.resolve('')
          : content(repoPath, oldName, oldRef).then(
              result => result.content ?? ''
            )
    };
    this.challenger = {
      label: change.path,
      source: referenceSource(newRef),
      content: () =>
        newRef === null
          ? Promise.resolve('')
          : content(repoPath, change.path, newRef).then(
              result => result.content ?? ''
            )
    };
  }

  readonly changed: ISignal<Git.Diff.IModel, Git.Diff.IModelChange> =
    new Signal<Git.Diff.IModel, Git.Diff.IModelChange>(this);
  reference: Git.Diff.IContent;
  challenger: Git.Diff.IContent;
  readonly filename: string;
  readonly oldFilename: string | undefined;
  readonly repositoryPath: string;
  readonly isBinary: boolean;
  readonly canDiscard: boolean;
}

/** Build a diff model for a single {@link IFileChange}. */
export function fileChangeToDiffModel(
  repoPath: string,
  change: IFileChange
): IXtralabDiffModel {
  return new FileChangeDiffModel(repoPath, change);
}
