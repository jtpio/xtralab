import {
  diffAcceptRejectHunk,
  hydratePartialDiff,
  type FileDiffMetadata
} from '@pierre/diffs';

/**
 * A short hash of a file chunk that changes with its content. The `index`
 * line is left out: git does not always hash the working-tree side.
 */
export function chunkFingerprint(chunk: string): string {
  let hash = 0x811c9dc5;
  for (const line of chunk.split('\n')) {
    if (line.startsWith('index ')) {
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Whether the texts filled into a patch diff still hold every hunk at its
 * place. Otherwise the library would rebuild the file from stale positions.
 */
function matchesPatch(
  patch: FileDiffMetadata,
  full: FileDiffMetadata
): boolean {
  for (const [index, hunk] of patch.hunks.entries()) {
    const start = full.hunks[index].additionLineIndex;
    for (let i = 0; i < hunk.additionCount; i++) {
      if (
        full.additionLines[start + i] !==
        patch.additionLines[hunk.additionLineIndex + i]
      ) {
        return false;
      }
    }
  }
  const last = full.hunks[full.hunks.length - 1];
  return (
    last === undefined ||
    full.additionLines.length - last.additionLineIndex - last.additionCount ===
      full.deletionLines.length - last.deletionLineIndex - last.deletionCount
  );
}

/**
 * The new text with one hunk of a patch diff reverted, through the library's
 * `diffAcceptRejectHunk`. Return `null` when the new text no longer matches
 * the patch, so a stale diff never writes.
 */
export function rejectHunk(
  fileDiff: FileDiffMetadata,
  hunkIndex: number,
  oldText: string,
  newText: string
): string | null {
  const full = hydratePartialDiff('clone', fileDiff, {
    oldFile: { name: fileDiff.prevName ?? fileDiff.name, contents: oldText },
    newFile: { name: fileDiff.name, contents: newText }
  });
  if (!matchesPatch(fileDiff, full)) {
    return null;
  }
  return diffAcceptRejectHunk(full, hunkIndex, 'reject').additionLines.join('');
}
