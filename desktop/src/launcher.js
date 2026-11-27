const themeToggle = document.getElementById('theme-toggle');
const themeIconUse = themeToggle.querySelector('use');
const themeOrder = ['auto', 'light', 'dark'];
const themeIcons = {
  auto: '#icon-circle-half',
  light: '#icon-sun',
  dark: '#icon-moon'
};
const themeLabels = {
  auto: 'System',
  light: 'Light',
  dark: 'Dark'
};

function getStoredTheme() {
  const stored = localStorage.getItem('xtralab.theme');
  return themeOrder.includes(stored) ? stored : 'auto';
}

function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('xtralab.theme');
  } else {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('xtralab.theme', theme);
  }
  themeIconUse.setAttribute('href', themeIcons[theme]);
  themeToggle.title = `Theme: ${themeLabels[theme]} — click to change`;
}

themeToggle.addEventListener('click', () => {
  const current = getStoredTheme();
  const next =
    themeOrder[(themeOrder.indexOf(current) + 1) % themeOrder.length];
  applyTheme(next);
});

applyTheme(getStoredTheme());

const welcomeView = document.getElementById('welcome-view');
const restoreView = document.getElementById('restore-view');
const restoreNote = document.getElementById('restore-note');
const restoreProgress = document.getElementById('restore-progress');
const restoreProgressFill = document.getElementById('restore-progress-fill');
const restoreList = document.getElementById('restore-list');
const restoreDismiss = document.getElementById('restore-dismiss');
const openFolderLink = document.getElementById('open-folder');
const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');
const recentClear = document.getElementById('recent-clear');
const statusElement = document.getElementById('status');
const updateSpinner = document.getElementById('update-spinner');
const updateMessage = document.getElementById('update-message');
const updateAction = document.getElementById('update-action');
const updateCheck = document.getElementById('update-check');
const appVersion = document.getElementById('app-version');

let homeDir = '';
let isBusy = false;
let updateState = null;
let restoreViewActive = false;
let restoreRows = [];

function updateActionAvailability() {
  openFolderLink.disabled = isBusy;
  recentClear.disabled = isBusy;
  updateAction.disabled = isBusy;
  for (const button of recentList.querySelectorAll('button')) {
    button.disabled = isBusy;
  }
}

function renderUpdateState(state) {
  updateState = state;
  appVersion.textContent = `v${state.currentVersion}`;

  let message = '';
  let messageTitle = '';
  let actionLabel = '';
  let emphasized = false;
  let spinning = false;

  switch (state.status) {
    case 'idle':
      actionLabel = 'Check for updates';
      break;
    case 'checking':
      spinning = true;
      message = 'Checking for updates...';
      break;
    case 'up-to-date':
      actionLabel = 'Check for updates';
      break;
    case 'update-available':
      message = `Version ${state.latestVersion} is available`;
      actionLabel = 'Download';
      emphasized = true;
      break;
    case 'downloading':
      spinning = true;
      message = `Downloading ${state.latestVersion || 'update'}...`;
      break;
    case 'ready':
      message = `Version ${state.latestVersion} downloaded`;
      actionLabel = 'Restart to update';
      emphasized = true;
      break;
    case 'error':
      message = state.error || 'Update failed';
      messageTitle = state.error || '';
      actionLabel = 'Check for updates';
      break;
  }

  updateSpinner.hidden = !spinning;
  updateMessage.textContent = message;
  updateMessage.title = messageTitle;
  updateMessage.classList.toggle('error', state.status === 'error');
  updateMessage.hidden = message === '';
  updateCheck.hidden = state.status !== 'up-to-date';
  updateAction.textContent = actionLabel;
  updateAction.hidden = actionLabel === '';
  updateAction.classList.toggle('is-accent', emphasized);
  updateActionAvailability();
}

// How far along one project is, as a fraction of its slice of the progress
// bar: the server start dominates the wait, the window appearing ends it.
const restoreStatusProgress = {
  starting: 0.1,
  ready: 0.6,
  opened: 1,
  failed: 1
};

function restoreRowIcon(status) {
  if (status === 'opened') {
    return createIcon('#icon-check');
  }
  if (status === 'failed') {
    return createIcon('#icon-xmark');
  }
  const spinner = document.createElement('span');
  spinner.className = 'restore-spinner';
  return spinner;
}

function syncRestoreRows(projects) {
  const sameRows =
    restoreRows.length === projects.length &&
    restoreRows.every((row, index) => {
      return row.folderPath === projects[index].folderPath;
    });
  if (!sameRows) {
    restoreRows = projects.map(project => {
      const item = document.createElement('div');
      item.className = 'restore-item';
      item.title = project.folderPath;

      const status = document.createElement('span');
      status.className = 'restore-status';

      const name = document.createElement('span');
      name.className = 'restore-name';
      name.textContent = folderName(project.folderPath);

      const detail = document.createElement('span');
      detail.className = 'restore-detail';
      detail.textContent = recentDetailFor(project.folderPath);

      item.append(status, name, detail);

      const error = document.createElement('p');
      error.className = 'restore-error';
      error.hidden = true;

      const entry = document.createElement('div');
      entry.className = 'restore-entry';
      entry.append(item, error);

      return {
        folderPath: project.folderPath,
        root: entry,
        statusEl: status,
        errorEl: error,
        lastStatus: null
      };
    });
    restoreList.replaceChildren(...restoreRows.map(row => row.root));
  }

  restoreRows.forEach((row, index) => {
    const project = projects[index];
    if (row.lastStatus === project.status) {
      return;
    }
    row.lastStatus = project.status;
    row.statusEl.dataset.status = project.status;
    row.statusEl.replaceChildren(restoreRowIcon(project.status));
    const failed = project.status === 'failed';
    row.errorEl.hidden = !failed || !project.error;
    row.errorEl.textContent = failed ? project.error || '' : '';
  });
}

// A clean restore ends with the main process closing the launcher; one with
// failures keeps the summary up until Continue is clicked.
function renderRestoreState(state) {
  const projects = state.projects || [];
  if (projects.length === 0) {
    if (restoreViewActive) {
      restoreViewActive = false;
      showWelcome();
    }
    return;
  }

  restoreViewActive = true;
  welcomeView.classList.add('is-inactive');
  restoreView.classList.remove('is-inactive');

  syncRestoreRows(projects);

  const total = projects.length;
  const failedCount = projects.filter(
    project => project.status === 'failed'
  ).length;
  let fraction = 0;
  for (const project of projects) {
    fraction += restoreStatusProgress[project.status] || 0;
  }
  const percent = state.restoring
    ? Math.max(Math.round((fraction / total) * 100), 4)
    : 100;
  restoreProgressFill.style.width = `${percent}%`;
  restoreProgress.setAttribute('aria-valuenow', String(percent));

  if (state.restoring) {
    restoreNote.textContent =
      total === 1
        ? 'Reopening the project from your last session...'
        : `Reopening ${total} projects from your last session...`;
    restoreDismiss.hidden = true;
  } else {
    restoreNote.textContent =
      failedCount === total
        ? 'The projects from your last session could not be reopened.'
        : 'Some projects from your last session could not be reopened.';
    restoreDismiss.hidden = failedCount === 0;
  }
}

function setBusy(busy, label = 'Opening...') {
  isBusy = busy;
  updateActionAvailability();
  if (busy) {
    statusElement.classList.remove('error');
    statusElement.textContent = label;
  }
}

function setReady(message = '') {
  setBusy(false);
  statusElement.classList.remove('error');
  statusElement.textContent = message;
}

function setError(message) {
  setBusy(false);
  statusElement.classList.add('error');
  statusElement.textContent = message;
}

function showWelcome() {
  restoreView.classList.add('is-inactive');
  welcomeView.classList.remove('is-inactive');
  setReady();
  updateActionAvailability();
}

function folderName(folderPath) {
  const normalized = folderPath.replace(/\/+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || folderPath;
}

function abbreviateHome(folderPath) {
  if (homeDir !== '' && folderPath === homeDir) {
    return '~';
  }
  if (homeDir !== '' && folderPath.startsWith(homeDir + '/')) {
    return '~/' + folderPath.slice(homeDir.length + 1);
  }
  if (homeDir !== '' && folderPath.startsWith(homeDir + '\\')) {
    return '~\\' + folderPath.slice(homeDir.length + 1);
  }
  return folderPath;
}

function parentDirOf(folderPath) {
  const normalized = folderPath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  if (parts.length <= 1) {
    return '';
  }
  parts.pop();
  const parent = parts.join('/');
  return parent === '' ? '/' : parent;
}

function recentDetailFor(folderPath) {
  const parent = parentDirOf(folderPath);
  if (parent === '') {
    return '';
  }
  return abbreviateHome(parent);
}

function createIcon(symbolId) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', symbolId);
  svg.append(use);
  return svg;
}

function createRecentRow(folderPath) {
  const item = document.createElement('div');
  item.className = 'recent-item';

  const row = document.createElement('button');
  row.className = 'recent-row';
  row.type = 'button';
  row.title = folderPath;

  const name = document.createElement('span');
  name.className = 'recent-name';
  name.textContent = folderName(folderPath);

  const detail = document.createElement('span');
  detail.className = 'recent-detail';
  detail.textContent = recentDetailFor(folderPath);

  row.append(name, detail);
  row.addEventListener('click', () => openFolder(folderPath));

  const remove = document.createElement('button');
  remove.className = 'recent-remove';
  remove.type = 'button';
  remove.title = `Remove ${folderName(folderPath)} from recent folders`;
  remove.setAttribute('aria-label', remove.title);
  remove.append(createIcon('#icon-xmark'));
  remove.addEventListener('click', async () => {
    const folders = await window.xtralab.forgetRecentFolder(folderPath);
    renderRecentFolders(folders);
  });

  item.append(row, remove);
  return item;
}

async function renderRecentFolders(folders) {
  const recentFolders = folders ?? (await window.xtralab.getRecentFolders());
  recentList.replaceChildren();

  if (recentFolders.length === 0) {
    recentSection.hidden = true;
    return;
  }

  recentSection.hidden = false;
  for (const folderPath of recentFolders) {
    recentList.append(createRecentRow(folderPath));
  }
}

async function openFolder(folderPath) {
  setBusy(true, `Opening ${folderName(folderPath)}...`);
  const result = await window.xtralab.openFolder(folderPath);
  if (!result.ok) {
    setError(result.error || 'Unable to open folder');
    await renderRecentFolders();
  }
}

openFolderLink.addEventListener('click', async () => {
  setBusy(true, 'Selecting folder...');
  const folderPath = await window.xtralab.openFolderDialog();
  if (folderPath === null) {
    setReady();
    return;
  }
  await openFolder(folderPath);
});

recentClear.addEventListener('click', async () => {
  const folders = await window.xtralab.clearRecentFolders();
  renderRecentFolders(folders);
});

restoreDismiss.addEventListener('click', async () => {
  restoreViewActive = false;
  try {
    await window.xtralab.dismissRestoreResult();
  } catch {
    // The summary is gone either way; the welcome view takes over.
  }
  showWelcome();
});

updateAction.addEventListener('click', () => {
  if (updateState === null) {
    return;
  }
  if (updateState.status === 'update-available') {
    void window.xtralab.downloadUpdate();
  } else if (updateState.status === 'ready') {
    void window.xtralab.restartToUpdate();
  } else {
    void window.xtralab.checkForUpdates();
  }
});

(async () => {
  // Resolved before anything renders: restore rows bake the home-relative
  // detail path in when they are created and never recompute it.
  try {
    homeDir = await window.xtralab.getHomeDir();
  } catch {
    homeDir = '';
  }
  window.xtralab.onUpdateState(renderUpdateState);
  window.xtralab.onRestoreState(renderRestoreState);
  try {
    renderUpdateState(await window.xtralab.getUpdateState());
  } catch {
    // The footer keeps its empty default when the state is unavailable.
  }
  try {
    renderRestoreState(await window.xtralab.getRestoreState());
  } catch {
    // The launcher stays usable when the restore state is unavailable.
  }
  updateActionAvailability();
  await renderRecentFolders();
})();
