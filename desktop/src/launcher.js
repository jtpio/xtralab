const openFolderButton = document.getElementById('open-folder');
const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');
const statusElement = document.getElementById('status');

function setBusy(isBusy, label = 'Opening...') {
  openFolderButton.disabled = isBusy;
  if (isBusy) {
    statusElement.classList.remove('error');
    statusElement.textContent = label;
  }
}

function setError(message) {
  statusElement.classList.add('error');
  statusElement.textContent = message;
}

function folderName(folderPath) {
  const normalized = folderPath.replace(/\/+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || folderPath;
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
    setBusy(true, `Opening ${folderName(folderPath)}...`);
    const result = await window.xtralab.openRecentFolder(folderPath);
    if (!result.ok) {
      openFolderButton.disabled = false;
      setError(result.error || 'Unable to open folder');
    }
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
  setBusy(true);
  const result = await window.xtralab.openFolder();
  if (!result.ok) {
    openFolderButton.disabled = false;
    statusElement.textContent = '';
    if (result.error) {
      setError(result.error);
    }
    await renderRecentFolders();
  }
});

void renderRecentFolders();
