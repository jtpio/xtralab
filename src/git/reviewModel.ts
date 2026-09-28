import { Notification } from '@jupyterlab/apputils';
import { PathExt, URLExt } from '@jupyterlab/coreutils';
import { Git } from '@jupyterlab/git';
import { Contents, ServerConnection } from '@jupyterlab/services';
import type { IStateDB } from '@jupyterlab/statedb';
import type { TranslationBundle } from '@jupyterlab/translation';
import { Poll } from '@lumino/polling';
import { ISignal, Signal } from '@lumino/signaling';
import {
  GIT_DIFF_FILE_BREAK_REGEX,
  processFile,
  type CodeViewDiffItem,
  type DiffLineAnnotation,
  type FileDiffMetadata
} from '@pierre/diffs';
import { prepareFileTreeInput } from '@pierre/trees';

import type { IDiffAskSource } from './askRequest';
import { content } from './api';
import { imageDataType } from './imageDiff';
import { chunkFingerprint, rejectHunk } from './reviewPatch';
import type { FileChangeStatus, IFileChange } from './tokens';

export type ReviewScope = 'uncommitted' | 'branch';

/**
 * Soft failures the server reports instead of a file list.
 */
export type ReviewError =
  | 'not-a-repository'
  | 'no-base'
  | 'unknown-base'
  | 'no-merge-base'
  | 'no-commits';

/**
 * One changed file as `/xtralab/git/review` reports it.
 */
export interface IReviewFile {
  /**
   * The repo-relative path of the new side.
   */
  path: string;
  /**
   * The old path of a rename.
   */
  from?: string;
  /**
   * The change status.
   */
  status: FileChangeStatus;
  /**
   * The number of added lines.
   */
  additions: number;
  /**
   * The number of deleted lines.
   */
  deletions: number;
  /**
   * Whether git treats the file as binary.
   */
  binary: boolean;
  /**
   * Whether the diff is too large for the patch.
   */
  tooLarge?: boolean;
}

/**
 * The response of `/xtralab/git/review`.
 */
interface IReviewResponse {
  /**
   * The scope the payload is for.
   */
  scope: ReviewScope;
  /**
   * The current branch; `null` on a detached HEAD.
   */
  branch: string | null;
  /**
   * The HEAD commit; `null` before the first commit.
   */
  head: string | null;
  /**
   * The local and remote branches other than the current one.
   */
  baseCandidates: string[];
  /**
   * The base branch used when none is chosen; `null` when none is found.
   */
  defaultBase: string | null;
  /**
   * The compared commit and the ref it comes from; `sha` is `null` when
   * the ref does not resolve.
   */
  base: { ref: string; sha: string | null } | null;
  /**
   * The changed files, untracked ones included.
   */
  files: IReviewFile[];
  /**
   * One git patch for all text files, without notebooks.
   */
  patch: string;
  /**
   * The soft failure, or `null`.
   */
  error: ReviewError | null;
  /**
   * Identifies the payload; sent back to skip unchanged ones.
   */
  etag: string;
}

/**
 * How the review tab shows a file.
 */
export type ReviewFileKind =
  | 'text'
  | 'notebook'
  | 'image'
  | 'binary'
  | 'large'
  | 'empty';

/**
 * Annotation payload of the per-hunk discard button.
 */
export interface IReviewHunkAnnotation {
  /**
   * The index of the hunk to discard.
   */
  hunkIndex: number;
}

export type ReviewItem = CodeViewDiffItem<IReviewHunkAnnotation>;

/**
 * One file of the review, with the item the diff list renders.
 */
export interface IReviewEntry {
  /**
   * The file as the server reports it.
   */
  file: IReviewFile;
  /**
   * How the file is shown.
   */
  kind: ReviewFileKind;
  /**
   * Changes when the diff of the file changes.
   */
  fingerprint: string;
  /**
   * The patch chunk of the file, when it has one.
   */
  chunk: string | null;
  /**
   * The parsed diff; hunks are empty for header-only kinds.
   */
  fileDiff: FileDiffMetadata;
  /**
   * The item shown in the diff list.
   */
  item: ReviewItem;
}

type ReviewEntryBase = Omit<IReviewEntry, 'item'>;

/**
 * Why a text file starts collapsed.
 */
export type ReviewCollapseReason =
  | 'renamed'
  | 'no-changes'
  | 'deleted'
  | 'lock-file'
  | 'large';

const VIEWED_STATE_KEY = 'xtralab:git-review:viewed';

const MAX_VIEWED_ENTRIES = 2000;

const POLL_INTERVAL_MS = 8000;

const POLL_MAX_MS = 300_000;

/**
 * Past this many changed lines a file starts collapsed.
 */
const LARGE_DIFF_LINES = 1000;

const LOCK_FILES = new Set([
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock'
]);

function isLockFile(path: string): boolean {
  return LOCK_FILES.has(PathExt.basename(path));
}

async function fetchReview(body: {
  path: string;
  scope: ReviewScope;
  base?: string;
  etag?: string;
}): Promise<IReviewResponse | null> {
  const settings = ServerConnection.makeSettings();
  const url = URLExt.join(settings.baseUrl, 'xtralab', 'git', 'review');
  const response = await ServerConnection.makeRequest(
    url,
    { method: 'POST', body: JSON.stringify(body) },
    settings
  );
  if (!response.ok) {
    throw new ServerConnection.ResponseError(response);
  }
  const data = (await response.json()) as IReviewResponse | { unchanged: true };
  return 'unchanged' in data ? null : data;
}

/**
 * The branches a review of the repository can compare with.
 */
export interface IReviewBases {
  /**
   * The current branch; `null` on a detached HEAD.
   */
  branch: string | null;
  /**
   * The base branch used when none is chosen.
   */
  defaultBase: string | null;
  /**
   * The local and remote branches other than the current one.
   */
  baseCandidates: string[];
}

/**
 * Fetch the branches of a repository; `null` outside a git repository.
 */
export async function fetchReviewBases(
  repoPath: string
): Promise<IReviewBases | null> {
  const settings = ServerConnection.makeSettings();
  const url =
    URLExt.join(settings.baseUrl, 'xtralab', 'git', 'bases') +
    URLExt.objectToQueryString({ path: repoPath });
  const response = await ServerConnection.makeRequest(url, {}, settings);
  if (!response.ok) {
    throw new ServerConnection.ResponseError(response);
  }
  const data = (await response.json()) as IReviewBases & {
    error: string | null;
  };
  return data.error === null ? data : null;
}

function fileKind(file: IReviewFile, chunk: string | null): ReviewFileKind {
  if (file.tooLarge === true) {
    return 'large';
  }
  if (file.path.toLowerCase().endsWith('.ipynb')) {
    return 'notebook';
  }
  if (file.binary) {
    return imageDataType(file.path) !== null ? 'image' : 'binary';
  }
  return chunk === null ? 'empty' : 'text';
}

function changeType(file: IReviewFile): FileDiffMetadata['type'] {
  switch (file.status) {
    case 'added':
    case 'untracked':
      return 'new';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'rename-changed';
    default:
      return 'change';
  }
}

/**
 * A diff with no hunks, for files shown by their header only.
 */
function headerOnlyDiff(file: IReviewFile): FileDiffMetadata {
  return {
    name: file.path,
    prevName: file.from,
    type: changeType(file),
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    additionLines: [],
    deletionLines: []
  };
}

/**
 * State of the review tab: one repository, one scope. The model polls the
 * server and keeps item identities stable, so the diff list only redraws
 * the files that changed.
 */
export class ReviewModel {
  constructor(options: ReviewModel.IOptions) {
    this.repoPath = options.repoPath;
    this._scope = options.scope;
    this._requestedBase = options.base ?? null;
    this._contents = options.contents;
    this._state = options.state;
    this._trans = options.trans;
    this._viewedReady = this._restoreViewed();
    this._poll = new Poll({
      auto: false,
      name: '@xtralab/git:review',
      factory: () => this._fetch(),
      frequency: {
        interval: POLL_INTERVAL_MS,
        backoff: true,
        max: POLL_MAX_MS
      },
      standby: () => !this._active || document.visibilityState === 'hidden'
    });
    this._contents.fileChanged.connect(this._onFileChanged, this);
    void this._poll.start();
  }

  /**
   * The server-relative path of the repository.
   */
  readonly repoPath: string;

  /**
   * A signal emitted when anything shown changes.
   */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * Bumped on each change, for render dependencies.
   */
  get revision(): number {
    return this._revision;
  }

  /**
   * The changes shown: uncommitted work, or the whole branch.
   */
  get scope(): ReviewScope {
    return this._scope;
  }

  /**
   * The base branch the user picked; `null` uses the default base.
   */
  get requestedBase(): string | null {
    return this._requestedBase;
  }

  /**
   * The base the server compared with.
   */
  get base(): { ref: string; sha: string | null } | null {
    return this._data?.base ?? null;
  }

  /**
   * The current branch; `null` on a detached HEAD.
   */
  get branch(): string | null {
    return this._data?.branch ?? null;
  }

  /**
   * The branches the Branch scope can compare with.
   */
  get baseCandidates(): readonly string[] {
    return this._data?.baseCandidates ?? [];
  }

  /**
   * The base branch used when none is chosen.
   */
  get defaultBase(): string | null {
    return this._data?.defaultBase ?? null;
  }

  /**
   * Whether the first response for the current scope is still pending.
   */
  get loading(): boolean {
    return this._data === null && this._requestError === null;
  }

  /**
   * The soft error of the server, or the request failure message.
   */
  get error(): { code: ReviewError | 'request'; message?: string } | null {
    if (this._requestError !== null) {
      return { code: 'request', message: this._requestError };
    }
    const code = this._data?.error ?? null;
    return code === null ? null : { code };
  }

  /**
   * The files in display order.
   */
  get entries(): readonly IReviewEntry[] {
    return this._entries;
  }

  /**
   * The diff list items, in the order of {@link entries}.
   */
  get items(): readonly ReviewItem[] {
    return this._items;
  }

  /**
   * Total added and deleted lines.
   */
  get totals(): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const entry of this._entries) {
      additions += entry.file.additions;
      deletions += entry.file.deletions;
    }
    return { additions, deletions };
  }

  /**
   * The entry of a repo-relative path.
   */
  entry(path: string): IReviewEntry | undefined {
    return this._byPath.get(path);
  }

  /**
   * Whether the file has a body to expand.
   */
  isCollapsible(entry: ReviewEntryBase): boolean {
    return entry.kind === 'text' && entry.fileDiff.hunks.length > 0;
  }

  /**
   * Whether hunks of the file can be discarded in the working tree.
   */
  isDiscardable(entry: ReviewEntryBase): boolean {
    return (
      entry.kind === 'text' &&
      (entry.fileDiff.type === 'change' ||
        entry.fileDiff.type === 'rename-changed')
    );
  }

  /**
   * Whether the user marked the current diff of the file viewed.
   */
  isViewed(path: string): boolean {
    const entry = this._byPath.get(path);
    return entry !== undefined && this._viewed.get(path) === entry.fingerprint;
  }

  /**
   * Whether the diff of the file changed since the user last looked.
   */
  isUpdated(path: string): boolean {
    return this._updated.has(path);
  }

  /**
   * Mark a file viewed, which collapses it, or not viewed.
   */
  setViewed(path: string, viewed: boolean): void {
    const entry = this._byPath.get(path);
    if (entry === undefined) {
      return;
    }
    this._viewed.delete(path);
    if (viewed) {
      this._viewed.set(path, entry.fingerprint);
      while (this._viewed.size > MAX_VIEWED_ENTRIES) {
        const oldest = this._viewed.keys().next().value as string;
        this._viewed.delete(oldest);
      }
    }
    this._collapsed.delete(path);
    this._updated.delete(path);
    this._saveViewed();
    this._rebuild(path);
  }

  /**
   * Collapse or expand one file; the choice holds until its diff changes.
   */
  setCollapsed(path: string, collapsed: boolean): void {
    const entry = this._byPath.get(path);
    if (entry === undefined || !this.isCollapsible(entry)) {
      return;
    }
    this._collapsed.set(path, collapsed);
    this._updated.delete(path);
    this._rebuild(path);
  }

  /**
   * Collapse or expand every file that has a body.
   */
  setAllCollapsed(collapsed: boolean): void {
    for (const entry of this._entries) {
      if (this.isCollapsible(entry)) {
        this._collapsed.set(entry.file.path, collapsed);
      }
    }
    this._rebuild();
  }

  /**
   * Forget the "changed since you looked" mark of a file.
   */
  acknowledge(path: string): void {
    if (this._updated.delete(path)) {
      this._emit();
    }
  }

  /**
   * Switch the scope or the base branch; a `null` base uses the default.
   */
  setScope(scope: ReviewScope, base?: string | null): void {
    const nextBase = base === undefined ? this._requestedBase : base;
    if (scope === this._scope && nextBase === this._requestedBase) {
      return;
    }
    this._scope = scope;
    this._requestedBase = nextBase;
    this._data = null;
    this._etag = undefined;
    this._requestError = null;
    this._entries = [];
    this._items = [];
    this._byPath.clear();
    this._collapsed.clear();
    this._updated.clear();
    this._loadedFiles.clear();
    this._emit();
    void this._poll.refresh();
  }

  /**
   * Fetch now.
   */
  async refresh(): Promise<void> {
    await this._poll.refresh();
    await this._poll.tick;
  }

  /**
   * Poll only while the tab is visible.
   */
  setActive(active: boolean): void {
    if (active === this._active) {
      return;
    }
    this._active = active;
    if (active) {
      void this._poll.refresh();
    }
  }

  /**
   * Load both sides of a file, for context expansion and agent asks.
   */
  loadFiles(
    entry: IReviewEntry
  ): Promise<{ oldText: string; newText: string }> {
    const key = `${entry.file.path}\0${entry.fingerprint}`;
    const cached = this._loadedFiles.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const { file } = entry;
    const baseSha = this.base?.sha ?? null;
    const readText = (result: { content?: string }): string =>
      result.content ?? '';
    const oldText =
      file.status === 'untracked' || file.status === 'added' || baseSha === null
        ? Promise.resolve('')
        : content(this.repoPath, file.from ?? file.path, { git: baseSha }).then(
            readText
          );
    const newText =
      file.status === 'deleted'
        ? Promise.resolve('')
        : content(this.repoPath, file.path, { special: 'WORKING' }).then(
            readText
          );
    const loaded = Promise.all([oldText, newText]).then(
      ([oldValue, newValue]) => ({ oldText: oldValue, newText: newValue })
    );
    loaded.catch(() => this._loadedFiles.delete(key));
    this._loadedFiles.set(key, loaded);
    return loaded;
  }

  /**
   * What an agent ask about lines of this file needs to know.
   */
  askSource(entry: IReviewEntry): IDiffAskSource {
    const base = this.base;
    const reference =
      this._scope === 'uncommitted' || base === null
        ? 'HEAD'
        : `merge base with ${base.ref} (${(base.sha ?? '').slice(0, 7)})`;
    return {
      filename: entry.file.path,
      repositoryPath: this.repoPath,
      reference: { source: reference },
      challenger: { source: Git.Diff.SpecialRef.WORKING }
    };
  }

  /**
   * The change to open in a single-file diff tab.
   */
  fileChange(entry: IReviewEntry): IFileChange | null {
    const base = this.base;
    if (base === null || base.sha === null) {
      return null;
    }
    const { file } = entry;
    return {
      path: file.path,
      ...(file.from !== undefined ? { from: file.from } : {}),
      group: 'unstaged',
      status: file.status,
      isBinary: file.binary,
      base: { sha: base.sha, label: base.ref }
    };
  }

  /**
   * Revert one hunk in the working tree, unless the file changed on disk.
   */
  async discardHunk(path: string, hunkIndex: number): Promise<void> {
    const entry = this._byPath.get(path);
    if (entry === undefined || !this.isDiscardable(entry)) {
      return;
    }
    const serverPath = PathExt.join(this.repoPath, path);
    try {
      const [{ oldText }, current] = await Promise.all([
        this.loadFiles(entry),
        this._contents.get(serverPath, {
          type: 'file',
          format: 'text',
          content: true
        })
      ]);
      const next = rejectHunk(
        entry.fileDiff,
        hunkIndex,
        oldText,
        String(current.content ?? '')
      );
      if (next === null) {
        Notification.warning(
          this._trans.__(
            '%1 changed on disk. The diff reloads; try again.',
            path
          ),
          { autoClose: 5000 }
        );
      } else {
        await this._contents.save(serverPath, {
          type: 'file',
          format: 'text',
          content: next
        });
      }
    } catch (reason) {
      Notification.error(
        this._trans.__('Could not discard the change in %1.', path)
      );
      console.error('xtralab: failed to discard a review hunk', reason);
    }
    await this.refresh();
  }

  /**
   * Stop polling and release the signals.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._poll.dispose();
    this._contents.fileChanged.disconnect(this._onFileChanged, this);
    Signal.clearData(this);
  }

  private _onFileChanged(): void {
    void this._poll.refresh();
  }

  private async _fetch(): Promise<void> {
    await this._viewedReady;
    const scope = this._scope;
    const base = this._requestedBase;
    let data: IReviewResponse | null;
    try {
      data = await fetchReview({
        path: this.repoPath,
        scope,
        ...(base !== null ? { base } : {}),
        ...(this._etag !== undefined ? { etag: this._etag } : {})
      });
    } catch (reason) {
      if (scope === this._scope && base === this._requestedBase) {
        this._requestError =
          reason instanceof Error ? reason.message : String(reason);
        this._emit();
      }
      throw reason;
    }
    if (
      this._disposed ||
      scope !== this._scope ||
      base !== this._requestedBase
    ) {
      return;
    }
    const hadError = this._requestError !== null;
    this._requestError = null;
    if (data === null) {
      if (hadError) {
        this._emit();
      }
      return;
    }
    const firstLoad = this._data === null;
    this._etag = data.etag;
    this._data = data;
    this._applyFiles(data, firstLoad);
  }

  /**
   * Rebuild the entries from a response, reusing the entries whose chunk
   * did not change.
   */
  private _applyFiles(data: IReviewResponse, firstLoad: boolean): void {
    const previousByChunk = new Map<string, IReviewEntry>();
    for (const entry of this._entries) {
      if (entry.chunk !== null) {
        previousByChunk.set(entry.chunk, entry);
      }
    }
    const chunkByPath = new Map<string, string>();
    const reusedByPath = new Map<string, IReviewEntry>();
    const parsedByPath = new Map<string, FileDiffMetadata>();
    // Split where the library parser splits, to reuse unchanged files.
    for (const chunk of data.patch.split(GIT_DIFF_FILE_BREAK_REGEX)) {
      const previous = previousByChunk.get(chunk);
      if (previous !== undefined) {
        chunkByPath.set(previous.file.path, chunk);
        reusedByPath.set(previous.file.path, previous);
        continue;
      }
      const fileDiff = processFile(chunk, {
        cacheKey: `review:${chunkFingerprint(chunk)}`
      });
      if (fileDiff !== undefined) {
        chunkByPath.set(fileDiff.name, chunk);
        parsedByPath.set(fileDiff.name, fileDiff);
      }
    }

    // The order of the file browser tree.
    const fileByPath = new Map(data.files.map(file => [file.path, file]));
    const files = prepareFileTreeInput([...fileByPath.keys()]).paths.map(
      path => fileByPath.get(path)!
    );
    const entries: IReviewEntry[] = [];
    const previousPaths = this._byPath;
    this._byPath = new Map();
    for (const file of files) {
      const chunk = chunkByPath.get(file.path) ?? null;
      const kind = fileKind(file, chunk);
      const fingerprint =
        chunk !== null
          ? chunkFingerprint(chunk)
          : `${file.status}:${file.additions}:${file.deletions}`;
      const previous = previousPaths.get(file.path);
      if (previous !== undefined && previous.fingerprint !== fingerprint) {
        this._collapsed.delete(file.path);
        this._updated.add(file.path);
      } else if (previous === undefined && !firstLoad) {
        this._updated.add(file.path);
      }
      const candidate =
        reusedByPath.get(file.path) ??
        (chunk === null && previous?.chunk === null ? previous : undefined);
      const reused =
        candidate !== undefined &&
        candidate.fingerprint === fingerprint &&
        candidate.kind === kind &&
        candidate.file.status === file.status
          ? candidate
          : undefined;
      const fileDiff =
        reused?.fileDiff ??
        (kind === 'text' ? parsedByPath.get(file.path) : undefined) ??
        headerOnlyDiff(file);
      const base: ReviewEntryBase = {
        file,
        kind,
        fingerprint,
        chunk,
        fileDiff
      };
      const entry: IReviewEntry = {
        ...base,
        item: this._itemFor(base, reused?.item)
      };
      entries.push(entry);
      this._byPath.set(file.path, entry);
    }
    for (const path of this._updated) {
      if (!this._byPath.has(path)) {
        this._updated.delete(path);
      }
    }
    this._entries = entries;
    this._items = entries.map(entry => entry.item);
    this._emit();
  }

  /**
   * Refresh the item of one path, or of all paths.
   */
  private _rebuild(path?: string): void {
    const targets =
      path === undefined
        ? this._entries
        : this._entries.filter(entry => entry.file.path === path);
    for (const entry of targets) {
      entry.item = this._itemFor(entry, entry.item);
    }
    this._items = this._entries.map(entry => entry.item);
    this._emit();
  }

  /**
   * Why a text file starts collapsed, apart from being viewed.
   */
  collapseReason(entry: ReviewEntryBase): ReviewCollapseReason | null {
    const { file } = entry;
    if (entry.kind !== 'text') {
      return null;
    }
    if (entry.fileDiff.hunks.length === 0) {
      return file.status === 'renamed' ? 'renamed' : 'no-changes';
    }
    if (file.status === 'deleted') {
      return 'deleted';
    }
    if (isLockFile(file.path)) {
      return 'lock-file';
    }
    if (file.additions + file.deletions > LARGE_DIFF_LINES) {
      return 'large';
    }
    return null;
  }

  private _defaultCollapsed(entry: ReviewEntryBase): boolean {
    return (
      this._viewed.get(entry.file.path) === entry.fingerprint ||
      this.collapseReason(entry) !== null
    );
  }

  /**
   * The item for an entry; the previous item is kept when nothing it shows
   * changed, so the diff list keeps its rendered state.
   */
  private _itemFor(entry: ReviewEntryBase, previous?: ReviewItem): ReviewItem {
    const path = entry.file.path;
    const collapsed = this.isCollapsible(entry)
      ? (this._collapsed.get(path) ?? this._defaultCollapsed(entry))
      : true;
    if (
      previous !== undefined &&
      previous.fileDiff === entry.fileDiff &&
      previous.collapsed === collapsed
    ) {
      return previous;
    }
    const annotations: DiffLineAnnotation<IReviewHunkAnnotation>[] =
      this.isDiscardable(entry)
        ? entry.fileDiff.hunks.map((hunk, hunkIndex) => ({
            side: 'additions',
            lineNumber: hunk.additionStart,
            metadata: { hunkIndex }
          }))
        : [];
    this._version += 1;
    return {
      id: path,
      type: 'diff',
      fileDiff: entry.fileDiff,
      annotations,
      collapsed,
      version: this._version
    };
  }

  private async _restoreViewed(): Promise<void> {
    if (this._state === null) {
      return;
    }
    try {
      const saved = (await this._state.fetch(VIEWED_STATE_KEY)) as Record<
        string,
        Record<string, string>
      > | null;
      const forRepo = saved?.[this.repoPath] ?? {};
      for (const [path, fingerprint] of Object.entries(forRepo)) {
        if (typeof fingerprint === 'string') {
          this._viewed.set(path, fingerprint);
        }
      }
    } catch (reason) {
      console.error('xtralab: failed to restore viewed review files', reason);
    }
  }

  private _saveViewed(): void {
    const state = this._state;
    if (state === null) {
      return;
    }
    const repoPath = this.repoPath;
    const forRepo = Object.fromEntries(this._viewed);
    void state
      .fetch(VIEWED_STATE_KEY)
      .then(saved => {
        const all = {
          ...((saved as Record<string, Record<string, string>> | null) ?? {}),
          [repoPath]: forRepo
        };
        return state.save(VIEWED_STATE_KEY, all);
      })
      .catch(reason => {
        console.error('xtralab: failed to save viewed review files', reason);
      });
  }

  private _emit(): void {
    this._revision += 1;
    this._changed.emit();
  }

  private _scope: ReviewScope;
  private _requestedBase: string | null;
  private _contents: Contents.IManager;
  private _state: IStateDB | null;
  private _trans: TranslationBundle;
  private _poll: Poll;
  private _active = true;
  private _disposed = false;
  private _data: IReviewResponse | null = null;
  private _etag: string | undefined = undefined;
  private _requestError: string | null = null;
  private _entries: IReviewEntry[] = [];
  private _items: ReviewItem[] = [];
  private _byPath = new Map<string, IReviewEntry>();
  private _collapsed = new Map<string, boolean>();
  private _viewed = new Map<string, string>();
  private _viewedReady: Promise<void>;
  private _updated = new Set<string>();
  private _loadedFiles = new Map<
    string,
    Promise<{ oldText: string; newText: string }>
  >();
  private _version = 0;
  private _revision = 0;
  private _changed = new Signal<this, void>(this);
}

/**
 * What to show instead of the file list, or `null` when there are files.
 */
export function reviewStatusMessage(
  model: ReviewModel,
  trans: TranslationBundle
): string | null {
  if (model.loading) {
    return trans.__('Loading changes…');
  }
  const error = model.error;
  const base = model.base?.ref ?? model.requestedBase ?? '';
  switch (error?.code) {
    case 'not-a-repository':
      return trans.__('This folder is not in a git repository.');
    case 'no-base':
      return model.baseCandidates.length > 0
        ? trans.__('No default base branch found. Choose one in the toolbar.')
        : trans.__('No other branch to compare with.');
    case 'unknown-base':
      return trans.__('The branch "%1" does not exist.', base);
    case 'no-merge-base':
      return trans.__('"%1" has no commit in common with this branch.', base);
    case 'no-commits':
      return trans.__('This repository has no commits yet.');
    case 'request':
      return trans.__('Could not load the changes: %1', error.message ?? '');
  }
  if (model.entries.length === 0) {
    return model.scope === 'uncommitted'
      ? trans.__('No uncommitted changes.')
      : trans.__('No changes on this branch.');
  }
  return null;
}

export namespace ReviewModel {
  /**
   * The options to create a {@link ReviewModel}.
   */
  export interface IOptions {
    /**
     * The server-relative path of the repository.
     */
    repoPath: string;
    /**
     * The first scope to show.
     */
    scope: ReviewScope;
    /**
     * The base branch of the Branch scope; omit for the default base.
     */
    base?: string | null;
    /**
     * Reads working-tree files and writes discarded hunks.
     */
    contents: Contents.IManager;
    /**
     * Keeps the viewed files; `null` keeps them in memory only.
     */
    state: IStateDB | null;
    /**
     * The application translation bundle.
     */
    trans: TranslationBundle;
  }
}
