import { PageConfig } from '@jupyterlab/coreutils';

/**
 * Whether the xtralab server extension runs; it sets `xtralabServer` in the
 * page config. JupyterLite has no server, so the features that need one
 * (agent checks, running-agent detection, git, MCP) stay off there.
 */
export function hasServerExtension(): boolean {
  return PageConfig.getOption('xtralabServer') === 'true';
}

/**
 * Whether git status and diffs can be requested: the server must run and the
 * `@jupyterlab/git` frontend must be enabled.
 */
export function hasGit(): boolean {
  return (
    hasServerExtension() &&
    !PageConfig.Extension.isDisabled('@jupyterlab/git:plugin')
  );
}
