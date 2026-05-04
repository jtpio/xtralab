import { Contents } from '@jupyterlab/services';

const DIR_SUFFIX = '/';

/**
 * The canonical path used by the root of the in-memory load-state map.
 * The tree itself does not surface a path for its root.
 */
export const ROOT_LOAD_KEY = '';

/**
 * Convert a {@link Contents.IModel} into the canonical path expected by
 * `@pierre/trees`. Directories carry a trailing slash so empty directories can
 * still be represented in the flat path list.
 */
export function toCanonicalPath(child: Contents.IModel): string {
  return child.type === 'directory' ? `${child.path}${DIR_SUFFIX}` : child.path;
}

/**
 * Strip the trailing slash that `@pierre/trees` uses for canonical directory
 * paths so the value can be sent to the Jupyter contents API.
 */
export function toServerPath(canonicalPath: string): string {
  if (canonicalPath === ROOT_LOAD_KEY) {
    return '';
  }
  return canonicalPath.endsWith(DIR_SUFFIX)
    ? canonicalPath.slice(0, -DIR_SUFFIX.length)
    : canonicalPath;
}

export interface IListedDirectory {
  /** Canonical paths for every immediate child of the requested directory. */
  paths: string[];
  /** Subset of {@link IListedDirectory.paths} that are directories. */
  subdirectories: string[];
}

/**
 * Fetch the immediate children of a directory through the Jupyter contents API
 * and return them as canonical `@pierre/trees` paths.
 */
export async function listDirectory(
  manager: Contents.IManager,
  serverPath: string
): Promise<IListedDirectory> {
  const model = await manager.get(serverPath, { content: true });
  if (model.type !== 'directory') {
    throw new Error(
      `Expected a directory at "${serverPath}", got "${model.type}"`
    );
  }
  const children =
    (model.content as ReadonlyArray<Contents.IModel> | null) ?? [];
  const paths: string[] = [];
  const subdirectories: string[] = [];
  for (const child of children) {
    const canonical = toCanonicalPath(child);
    paths.push(canonical);
    if (child.type === 'directory') {
      subdirectories.push(canonical);
    }
  }
  return { paths, subdirectories };
}
