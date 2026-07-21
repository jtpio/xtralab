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
const projectView = document.getElementById('project-view');
const openFolderLink = document.getElementById('open-folder');
const backLink = document.getElementById('back-to-welcome');
const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');
const recentClear = document.getElementById('recent-clear');
const projectFolderName = document.getElementById('project-folder-name');
const projectFolderPath = document.getElementById('project-folder-path');
const environmentSelect = document.getElementById('environment-select');
const environmentDetail = document.getElementById('environment-detail');
const chooseInterpreterButton = document.getElementById('choose-interpreter');
const launchFolderButton = document.getElementById('launch-folder');
const statusElement = document.getElementById('status');
const updateSpinner = document.getElementById('update-spinner');
const updateMessage = document.getElementById('update-message');
const updateAction = document.getElementById('update-action');
const updateCheck = document.getElementById('update-check');
const appVersion = document.getElementById('app-version');

let homeDir = '';
let preparedFolder = null;
let isBusy = false;
let updateState = null;

function updateActionAvailability() {
  const option = selectedEnvironment();
  openFolderLink.disabled = isBusy;
  chooseInterpreterButton.disabled = isBusy || preparedFolder === null;
  launchFolderButton.disabled =
    isBusy ||
    preparedFolder === null ||
    option === null ||
    (option.kind !== 'managed' && !option.hasIpykernel);
  backLink.disabled = isBusy;
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
  preparedFolder = null;
  projectView.classList.add('is-inactive');
  welcomeView.classList.remove('is-inactive');
  setReady();
  updateActionAvailability();
}

function showProject() {
  welcomeView.classList.add('is-inactive');
  projectView.classList.remove('is-inactive');
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

function environmentValue(option) {
  return option.pythonPath || '';
}

function selectedEnvironment() {
  if (preparedFolder === null) {
    return null;
  }
  return (
    preparedFolder.environments.find(
      option => environmentValue(option) === environmentSelect.value
    ) || null
  );
}

function renderEnvironmentDetail() {
  const option = selectedEnvironment();
  if (option === null) {
    environmentDetail.textContent = '';
    updateActionAvailability();
    return;
  }

  const details = [option.detail];
  if (option.hasIpykernel) {
    details.push('Python 3 kernel will use this environment');
  } else if (option.kind !== 'managed') {
    details.push('Install ipykernel to use this environment');
  }
  environmentDetail.textContent = details.join(' · ');
  updateActionAvailability();
}

function renderPreparedFolder(result) {
  if (!result.ok) {
    setError(result.error || 'Unable to inspect folder');
    return;
  }

  preparedFolder = {
    folderPath: result.folderPath,
    environments: result.environments || [],
    selectedPythonPath: result.selectedPythonPath ?? null
  };

  projectFolderName.textContent = folderName(preparedFolder.folderPath);
  projectFolderPath.textContent = preparedFolder.folderPath;
  environmentSelect.replaceChildren();

  for (const option of preparedFolder.environments) {
    const element = document.createElement('option');
    element.value = environmentValue(option);
    element.textContent = option.label;
    environmentSelect.append(element);
  }

  environmentSelect.value = preparedFolder.selectedPythonPath || '';
  showProject();
  setReady();
  renderEnvironmentDetail();
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
  row.addEventListener('click', async () => {
    setBusy(true, `Inspecting ${folderName(folderPath)}...`);
    const result = await window.xtralab.openRecentFolder(folderPath);
    renderPreparedFolder(result);
  });

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

openFolderLink.addEventListener('click', async () => {
  setBusy(true, 'Selecting folder...');
  const result = await window.xtralab.openFolderDialog();
  if (!result.ok && !result.error) {
    setReady();
    return;
  }
  renderPreparedFolder(result);
  await renderRecentFolders();
});

recentClear.addEventListener('click', async () => {
  const folders = await window.xtralab.clearRecentFolders();
  renderRecentFolders(folders);
});

backLink.addEventListener('click', () => {
  showWelcome();
});

environmentSelect.addEventListener('change', () => {
  renderEnvironmentDetail();
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

chooseInterpreterButton.addEventListener('click', async () => {
  if (preparedFolder === null) {
    return;
  }
  setBusy(true, 'Selecting interpreter...');
  const result = await window.xtralab.selectPythonInterpreter(
    preparedFolder.folderPath
  );
  renderPreparedFolder(result);
});

launchFolderButton.addEventListener('click', async () => {
  const option = selectedEnvironment();
  if (preparedFolder === null || option === null) {
    return;
  }
  setBusy(true, `Opening ${folderName(preparedFolder.folderPath)}...`);
  const result = await window.xtralab.openFolder(
    preparedFolder.folderPath,
    option.pythonPath
  );
  if (!result.ok) {
    setError(result.error || 'Unable to open folder');
    await renderRecentFolders();
  }
});

(async () => {
  window.xtralab.onUpdateState(renderUpdateState);
  try {
    renderUpdateState(await window.xtralab.getUpdateState());
  } catch {
    // The footer keeps its empty default when the state is unavailable.
  }
  try {
    homeDir = await window.xtralab.getHomeDir();
  } catch {
    homeDir = '';
  }
  updateActionAvailability();
  await renderRecentFolders();
})();
