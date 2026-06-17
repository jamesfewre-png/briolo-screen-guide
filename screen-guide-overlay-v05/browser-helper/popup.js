const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('toggle');
let enabled = true;

async function refresh() {
  chrome.runtime.sendMessage({ type: 'SCREEN_GUIDE_STATUS' }, (res) => {
    enabled = res?.enabled !== false;
    statusEl.textContent = JSON.stringify(res, null, 2);
    toggleBtn.textContent = enabled ? 'Disable helper' : 'Enable helper';
  });
}

toggleBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SCREEN_GUIDE_SET_ENABLED', enabled: !enabled }, refresh);
});

refresh();
