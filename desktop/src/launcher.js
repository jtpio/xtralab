const openFolderButton = document.getElementById('open-folder');
const projectSection = document.getElementById('project-section');
const projectFolderName = document.getElementById('project-folder-name');
const projectFolderPath = document.getElementById('project-folder-path');
const environmentSelect = document.getElementById('environment-select');
const environmentDetail = document.getElementById('environment-detail');
const chooseInterpreterButton = document.getElementById('choose-interpreter');
const launchFolderButton = document.getElementById('launch-folder');
const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');
const statusElement = document.getElementById('status');
const bootstrapBanner = document.getElementById('bootstrap-banner');
const bootstrapTitle = document.getElementById('bootstrap-title');
const bootstrapDetail = document.getElementById('bootstrap-detail');
const bootstrapRetryButton = document.getElementById('bootstrap-retry');

const BOOTSTRAP_LABELS = {
  idle: 'Preparing runtime…',
  preparing: 'Setting up Python environment…',
  'installing-deps': 'Installing JupyterLab and dependencies…',
  'installing-xtralab': 'Finalizing xtralab…'
};

let preparedFolder = null;
let isBusy = false;
let bootstrapReady = false;

function updateActionAvailability() {
  const blocked = isBusy || !bootstrapReady;
  openFolderButton.disabled = blocked;
  chooseInterpreterButton.disabled = blocked || preparedFolder === null;
  launchFolderButton.disabled =
    blocked || preparedFolder === null || selectedEnvironment() === null;
  for (const button of recentList.querySelectorAll('button')) {
    button.disabled = blocked;
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

function applyBootstrapState(state) {
  bootstrapReady = state.kind === 'ready';

  if (state.kind === 'ready') {
    bootstrapBanner.hidden = true;
    bootstrapBanner.classList.remove('error');
    bootstrapDetail.hidden = true;
    bootstrapRetryButton.hidden = true;
  } else if (state.kind === 'error') {
    bootstrapBanner.hidden = false;
    bootstrapBanner.classList.add('error');
    bootstrapTitle.textContent = 'Could not set up the Python runtime.';
    bootstrapDetail.hidden = false;
    bootstrapDetail.textContent = state.message;
    bootstrapRetryButton.hidden = false;
  } else {
    bootstrapBanner.hidden = false;
    bootstrapBanner.classList.remove('error');
    bootstrapTitle.textContent =
      BOOTSTRAP_LABELS[state.kind] || BOOTSTRAP_LABELS.idle;
    bootstrapDetail.hidden = true;
    bootstrapRetryButton.hidden = true;
  }

  updateActionAvailability();
}

function folderName(folderPath) {
  const normalized = folderPath.replace(/\/+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || folderPath;
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

function optionLabel(option) {
  if (option.kind === 'managed') {
    return option.label;
  }
  const suffixes = [];
  if (option.hasIpykernel) {
    suffixes.push('Python kernel');
  }
  if (option.hasKernels) {
    suffixes.push('kernels');
  }
  if (option.hasLabExtensions) {
    suffixes.push('Lab extensions');
  }
  return suffixes.length
    ? `${option.label} (${suffixes.join(', ')})`
    : option.label;
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
    details.push('No Python ipykernel detected');
  }
  if (option.hasKernels) {
    details.push('Installed kernels detected');
  }
  if (option.hasLabExtensions) {
    details.push('JupyterLab extensions detected');
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
    element.textContent = optionLabel(option);
    environmentSelect.append(element);
  }

  environmentSelect.value = preparedFolder.selectedPythonPath || '';
  projectSection.hidden = false;
  setReady();
  renderEnvironmentDetail();
}

function createRecentButton(folderPath) {
  const button = document.createElement('button');
  button.className = 'recent-button';
  button.type = 'button';

  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folderName(folderPath);

  const path = document.createElement('span');
  path.className = 'folder-path';
  path.textContent = folderPath;

  button.append(name, path);
  button.addEventListener('click', async () => {
    setBusy(true, `Inspecting ${folderName(folderPath)}...`);
    const result = await window.xtralab.openRecentFolder(folderPath);
    renderPreparedFolder(result);
  });

  return button;
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
    recentList.append(createRecentButton(folderPath));
  }
}

openFolderButton.addEventListener('click', async () => {
  setBusy(true, 'Selecting folder...');
  const result = await window.xtralab.openFolderDialog();
  if (!result.ok && !result.error) {
    setReady();
    return;
  }
  renderPreparedFolder(result);
  await renderRecentFolders();
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

const shell = document.querySelector('.shell');
if (shell !== null) {
  let lastReported = 0;
  const observer = new ResizeObserver(() => {
    const height = shell.offsetHeight;
    if (height > 0 && Math.abs(height - lastReported) >= 1) {
      lastReported = height;
      void window.xtralab.setLauncherContentHeight(height);
    }
  });
  observer.observe(shell);
}

bootstrapRetryButton.addEventListener('click', () => {
  void window.xtralab.retryBootstrap();
});

let bootstrapStateInitialized = false;
window.xtralab.onBootstrapState(state => {
  bootstrapStateInitialized = true;
  applyBootstrapState(state);
});
void window.xtralab.getBootstrapState().then(state => {
  if (!bootstrapStateInitialized) {
    applyBootstrapState(state);
  }
});

void renderRecentFolders();
