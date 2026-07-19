import { Git } from '@jupyterlab/git';
import { ISignal, Signal } from '@lumino/signaling';

import { content } from './api';
import type { IXtralabDiffModel } from './diffWidget';
import type { GitReference, IFileChange } from './tokens';

/**
 * Resolve the old/new git refs for a launcher file change. Staged diffs are
 * INDEX vs HEAD; unstaged diffs are WORKING vs INDEX.
 */
function resolveReferences(change: IFileChange): {
  oldRef: GitReference | null;
  newRef: GitReference | null;
} {
  if (change.status === 'untracked') {
    return { oldRef: null, newRef: { special: 'WORKING' } };
  }
  if (change.group === 'staged') {
    return { oldRef: { git: 'HEAD' }, newRef: { special: 'INDEX' } };
  }
  // If INDEX has no blob, the server falls back to HEAD as the baseline.
  return { oldRef: { special: 'INDEX' }, newRef: { special: 'WORKING' } };
}

/**
 * Map a launcher git ref onto `Git.Diff.IContent.source`; keep JupyterLab's
 * enum values where downstream diff code checks for them.
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
 * `Git.Diff.IModel` adapter for launcher file changes.
 */
class FileChangeDiffModel implements IXtralabDiffModel {
  constructor(repoPath: string, change: IFileChange) {
    const { oldRef, newRef } = resolveReferences(change);
    // Renames compare the new path against the old path's previous content.
    const oldName = change.from ?? change.path;
    this.filename = change.path;
    this.oldFilename = change.from;
    this.repositoryPath = repoPath;
    this.isBinary = change.isBinary === true;
    // Only unstaged tracked files can be reverted through a working-tree save.
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

/**
 * Build a diff model for a single {@link IFileChange}.
 */
export function fileChangeToDiffModel(
  repoPath: string,
  change: IFileChange
): IXtralabDiffModel {
  return new FileChangeDiffModel(repoPath, change);
}
