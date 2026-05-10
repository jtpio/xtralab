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
  const next = themeOrder[(themeOrder.indexOf(current) + 1) % themeOrder.length];
  applyTheme(next);
});

applyTheme(getStoredTheme());

const welcomeView = document.getElementById('welcome-view');
const projectView = document.getElementById('project-view');
const openFolderLink = document.getElementById('open-folder');
const backLink = document.getElementById('back-to-welcome');
const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');
const projectFolderName = document.getElementById('project-folder-name');
const projectFolderPath = document.getElementById('project-folder-path');
const environmentSelect = document.getElementById('environment-select');
const environmentDetail = document.getElementById('environment-detail');
const chooseInterpreterButton = document.getElementById('choose-interpreter');
const launchFolderButton = document.getElementById('launch-folder');
const statusElement = document.getElementById('status');

let homeDir = '';
let preparedFolder = null;
let isBusy = false;

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
  for (const button of recentList.querySelectorAll('button')) {
    button.disabled = isBusy;
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

function createRecentRow(folderPath) {
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

  return row;
}

async function renderRecentFolders() {
  const recentFolders = await window.xtralab.getRecentFolders();
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

backLink.addEventListener('click', () => {
  showWelcome();
});

environmentSelect.addEventListener('change', () => {
  renderEnvironmentDetail();
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
  try {
    homeDir = await window.xtralab.getHomeDir();
  } catch {
    homeDir = '';
  }
  updateActionAvailability();
  await renderRecentFolders();
})();
