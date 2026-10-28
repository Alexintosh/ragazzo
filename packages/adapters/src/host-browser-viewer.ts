/** Sandboxed browser viewer. Transport credentials stay in the server proxy, never this page. */
export function hostBrowserViewerHtml(interactive: boolean): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser</title>
<style>
:root{color-scheme:light dark;font:13px system-ui;background:Canvas;color:CanvasText}
*{box-sizing:border-box}body{margin:0;height:100dvh;display:flex;flex-direction:column}
nav{display:flex;align-items:center;gap:4px;padding:6px;border-bottom:1px solid ButtonBorder}
button,input{font:inherit;color:inherit;background:ButtonFace;border:1px solid ButtonBorder;border-radius:5px;padding:5px 8px}
button{cursor:pointer}button:disabled{cursor:default;color:GrayText}input{min-width:0;flex:1;background:Field;color:FieldText}
#tabs{overflow:auto;flex-shrink:0}#tabs button{white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
#tabs button[aria-pressed=true]{font-weight:600;background:CanvasText;color:Canvas}
#screen{min-height:0;flex:1;display:grid;place-items:center;overflow:hidden}
canvas{max-width:100%;max-height:100%;object-fit:contain;outline:none;touch-action:none}
[hidden]{display:none!important}#error{padding:10px;margin:0;color:CanvasText}
dialog{max-width:min(440px,90vw);max-height:90dvh;overflow:auto;border:1px solid ButtonBorder;border-radius:10px;padding:20px;background:Canvas;color:CanvasText}
dialog::backdrop{background:CanvasText;opacity:.35}dialog form{display:grid;gap:16px}dialog p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
dialog input{width:100%}dialog footer{display:flex;justify-content:flex-end;gap:8px}
</style></head><body>
<nav id="tabs" aria-label="Browser tabs"></nav>
<nav aria-label="Browser navigation">
<button id="back" aria-label="Back" title="Back">←</button><button id="forward" aria-label="Forward" title="Forward">→</button>
<button id="reload" aria-label="Reload" title="Reload">↻</button>
<input id="address" aria-label="Address" autocomplete="off" spellcheck="false">
<button id="new-tab" aria-label="New tab" title="New tab">+</button>
<button id="close-tab" aria-label="Close tab" title="Close tab">×</button>
</nav>
<p id="error" role="alert" hidden></p>
<div id="screen"><canvas tabindex="0" aria-label="Browser page"></canvas></div>
<dialog id="page-dialog" aria-label="Page dialog" aria-describedby="dialog-message">
<form><p id="dialog-message"></p><input id="dialog-prompt" aria-label="Response" autocomplete="off">
<footer><button id="dialog-dismiss" type="button">Cancel</button><button id="dialog-accept" type="button">OK</button></footer></form>
</dialog>
<script>
(() => {
  const interactive = ${JSON.stringify(interactive)};
  const canvas = document.querySelector('canvas');
  const context = canvas.getContext('2d');
  const address = document.getElementById('address');
  const tabs = document.getElementById('tabs');
  const error = document.getElementById('error');
  const dialog = document.getElementById('page-dialog');
  const dialogMessage = document.getElementById('dialog-message');
  const dialogPrompt = document.getElementById('dialog-prompt');
  const dialogAccept = document.getElementById('dialog-accept');
  const dialogDismiss = document.getElementById('dialog-dismiss');
  let dialogSignature = '';
  let dialogState;
  let dialogPending = false;
  let currentTab;
  let tabSignature = '';
  let stopped = false;
  let timer;
  let queue = Promise.resolve();
  const lifetime = new AbortController();
  const report = (state, detail) => {
    document.documentElement.className = 'noVNC_' + state;
    if (state === 'failed') document.documentElement.setAttribute('data-rakazo-screen-error', detail || 'Browser unavailable');
    else document.documentElement.removeAttribute('data-rakazo-screen-error');
    window.parent.postMessage({ rakazoScreen: state, ...(detail ? { detail } : {}) }, '*');
    window.ReactNativeWebView?.postMessage(JSON.stringify({ rakazoScreen: state }));
  };
  const fail = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    lifetime.abort();
    context.clearRect(0, 0, canvas.width, canvas.height);
    dialog.close();
    dialogMessage.textContent = '';
    dialogPrompt.value = '';
    error.hidden = false;
    error.textContent = 'Browser unavailable';
    report('failed', error.textContent);
  };
  const request = async (resource, command) => {
    const response = await fetch(new URL(resource, window.location.href), {
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
      ...(command ? { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(command) } : {}),
    });
    if (!response.ok) throw new Error('Browser unavailable');
    return response.json();
  };
  const draw = async (state) => {
    if (stopped) return;
    const image = new Image();
    image.src = 'data:' + state.image.mimeType + ';base64,' + state.image.data;
    await image.decode();
    if (stopped) return;
    canvas.width = state.image.width;
    canvas.height = state.image.height;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const active = state.tabs.find(tab => tab.active);
    currentTab = active?.id;
    if (document.activeElement !== address) address.value = active?.url || '';
    const signature = JSON.stringify(state.tabs);
    if (signature !== tabSignature) {
      tabSignature = signature;
      tabs.replaceChildren(...state.tabs.map(tab => {
        const button = document.createElement('button');
        button.textContent = tab.title || tab.url || 'New tab';
        button.title = tab.url;
        button.setAttribute('aria-pressed', String(tab.active));
        button.disabled = !interactive;
        button.onclick = () => send({ action: 'selectTab', tabId: tab.id });
        return button;
      }));
    }
    const signatureDialog = state.dialog ? JSON.stringify(state.dialog) : '';
    if (!state.dialog) {
      dialog.close();
      dialogState = undefined;
      dialogSignature = '';
      dialogPending = false;
      dialogMessage.textContent = '';
      dialogPrompt.value = '';
    } else if (signatureDialog !== dialogSignature) {
      dialogSignature = signatureDialog;
      dialogState = state.dialog;
      dialogPending = false;
      dialogMessage.textContent = state.dialog.message;
      dialogPrompt.hidden = state.dialog.type !== 'prompt';
      dialogPrompt.value = state.dialog.defaultPrompt || '';
      dialogPrompt.disabled = !interactive;
      dialogAccept.disabled = !interactive;
      dialogDismiss.disabled = !interactive;
      dialogDismiss.hidden = state.dialog.type === 'alert';
      if (!dialog.open) dialog.showModal();
      if (interactive) (dialogPrompt.hidden ? dialogAccept : dialogPrompt).focus();
    }
    report('connected');
  };
  const send = command => {
    if (!interactive || stopped) return;
    queue = queue.then(async () => {
      if (stopped) return;
      await request('input', command);
    }).catch(fail);
  };
  const answerDialog = accept => {
    if (!interactive || stopped || !dialogState || dialogPending) return;
    dialogPending = true;
    dialogAccept.disabled = true;
    dialogDismiss.disabled = true;
    dialogPrompt.disabled = true;
    send({ action: 'dialog', dialogId: dialogState.id, accept, ...(accept && dialogState.type === 'prompt' ? { text: dialogPrompt.value } : {}) });
  };
  const dialogForm = dialog.querySelector('form');
  dialogForm.onsubmit = event => { event.preventDefault(); answerDialog(true); };
  // The viewer sandbox forbids form navigation; handle Enter without submitting a document.
  dialogForm.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); answerDialog(true); }
  };
  dialogAccept.onclick = () => answerDialog(true);
  dialogDismiss.onclick = () => answerDialog(false);
  dialog.oncancel = event => { event.preventDefault(); answerDialog(false); };
  const poll = async () => {
    try {
      await queue;
      if (stopped) return;
      await draw(await request('frame'));
      if (!stopped) timer = setTimeout(poll, 250);
    } catch { fail(); }
  };
  for (const action of ['back', 'forward', 'reload']) {
    const button = document.getElementById(action);
    button.disabled = !interactive;
    button.onclick = () => send({ action });
  }
  document.getElementById('new-tab').hidden = !interactive;
  document.getElementById('close-tab').hidden = !interactive;
  document.getElementById('new-tab').onclick = () => send({ action: 'newTab' });
  document.getElementById('close-tab').onclick = () => currentTab && send({ action: 'closeTab', tabId: currentTab });
  address.readOnly = !interactive;
  address.onkeydown = event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      send({ action: 'navigate', url: address.value });
      canvas.focus();
    }
  };
  const input = value => send({ action: 'input', inputs: [value] });
  const position = event => {
    const rect = canvas.getBoundingClientRect();
    // object-fit letterboxes the page when either axis constrains the canvas.
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const left = rect.left + (rect.width - canvas.width * scale) / 2;
    const top = rect.top + (rect.height - canvas.height * scale) / 2;
    return { x: Math.max(0, Math.min(canvas.width - 1, (event.clientX - left) / scale)),
      y: Math.max(0, Math.min(canvas.height - 1, (event.clientY - top) / scale)) };
  };
  const pointer = (event, type) => {
    if (!interactive) return;
    event.preventDefault();
    input({ kind: 'pointer', type, ...position(event), button: event.button === 2 ? 'right' : 'left' });
  };
  canvas.onpointerdown = event => { if (!interactive) return; canvas.focus(); canvas.setPointerCapture(event.pointerId); pointer(event, 'down'); };
  canvas.onpointerup = event => pointer(event, 'up');
  canvas.onpointercancel = event => pointer(event, 'up');
  canvas.onpointermove = event => { if (event.buttons) pointer(event, 'move'); };
  canvas.oncontextmenu = event => event.preventDefault();
  canvas.addEventListener('wheel', event => {
    if (!interactive) return;
    event.preventDefault();
    input({ kind: 'scroll', direction: event.deltaY < 0 ? 'up' : 'down', amount: Math.max(1, Math.min(20, Math.ceil(Math.abs(event.deltaY) / 100))) });
  }, { passive: false });
  // Native mobile keys use the same bridge as the computer's existing noVNC viewer.
  window.rakazoComputerKeyboard = { run(command) {
    if (!interactive || stopped || !command) return;
    if (command.type === 'text') input({ kind: 'clipboard', text: command.text });
    else if (command.type === 'backspace') {
      const count = Math.max(0, Math.min(1000, Math.floor(command.count)));
      for (let offset = 0; offset < count; offset += 32) {
        send({ action: 'input', inputs: Array.from({ length: Math.min(32, count - offset) }, () => ({ kind: 'key', key: 'Backspace' })) });
      }
    } else if (command.type === 'key' || command.type === 'char') {
      input({ kind: 'key', key: command.name === 'Return' ? 'Enter' : command.name || command.text,
        modifiers: command.control ? ['Control'] : [] });
    }
  } };
  canvas.onkeydown = event => {
    if (!interactive || event.isComposing || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    event.preventDefault();
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      input({ kind: 'clipboard', text: event.key });
    } else {
      input({ kind: 'key', key: event.key, modifiers: [event.ctrlKey && 'Control', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean) });
    }
  };
  canvas.onpaste = event => {
    if (!interactive) return;
    event.preventDefault();
    input({ kind: 'clipboard', text: event.clipboardData?.getData('text/plain') || '' });
  };
  window.addEventListener('message', event => {
    if (event.source === window.parent && event.data?.rakazoScreenFocus === true) canvas.focus();
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); lifetime.abort(); });
  report('connecting');
  void poll();
})();
</script></body></html>`;
}
