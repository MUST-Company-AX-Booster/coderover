/**
 * CodeRover VS Code extension — Phase 9 / Workstream E scaffold.
 *
 * Commands:
 *   coderover.setApiToken : prompts for API token, stores in SecretStorage
 *   coderover.search      : input → /search → quick-pick → open file
 *   coderover.chat        : opens a webview bound to /copilot/chat SSE
 *   coderover.reviewPr    : looks up current-branch PR → shows findings
 */
const vscode = require('vscode');

const TOKEN_KEY = 'coderover.apiToken';

async function getToken(context) {
  return context.secrets.get(TOKEN_KEY);
}

async function setToken(context) {
  const token = await vscode.window.showInputBox({
    prompt: 'Paste your CodeRover API token',
    ignoreFocusOut: true,
    password: true,
  });
  if (!token) return;
  await context.secrets.store(TOKEN_KEY, token);
  vscode.window.showInformationMessage('CodeRover token saved.');
}

function apiBase() {
  return vscode.workspace.getConfiguration('coderover').get('apiBaseUrl', 'http://localhost:3001');
}

async function apiGet(context, path) {
  const token = await getToken(context);
  if (!token) {
    vscode.window.showWarningMessage('Set your CodeRover API token first.');
    return null;
  }
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    vscode.window.showErrorMessage(`CodeRover API ${res.status}`);
    return null;
  }
  return res.json();
}

async function searchCommand(context) {
  const query = await vscode.window.showInputBox({ prompt: 'Search codebase…' });
  if (!query) return;
  const results = await apiGet(context, `/search?q=${encodeURIComponent(query)}`);
  if (!results || !Array.isArray(results.items)) return;
  const pick = await vscode.window.showQuickPick(
    results.items.map(r => ({
      label: r.path || r.filePath,
      description: `L${r.line ?? 1}`,
      detail: (r.snippet || '').slice(0, 120),
      raw: r,
    })),
    { placeHolder: `${results.items.length} results` },
  );
  if (!pick) return;
  const file = pick.raw.path || pick.raw.filePath;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  try {
    const uri = vscode.Uri.file(`${root}/${file}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const line = (pick.raw.line ?? 1) - 1;
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open ${file}`);
  }
}

function chatCommand(context) {
  const panel = vscode.window.createWebviewPanel(
    'coderoverChat', 'CodeRover Chat', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = `<!doctype html><html><head><style>
    body { font: 13px system-ui; padding: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    #chat { white-space: pre-wrap; margin-bottom: 12px; min-height: 200px; }
    #row { display: flex; gap: 6px; }
    #input { flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
    button { padding: 6px 12px; }
  </style></head>
  <body>
    <h3>CodeRover Chat</h3>
    <div id="chat"></div>
    <div id="row"><input id="input" placeholder="Ask about the codebase…" /><button id="send">Send</button></div>
    <script>
      const vscode = acquireVsCodeApi();
      const chat = document.getElementById('chat');
      const input = document.getElementById('input');
      document.getElementById('send').addEventListener('click', send);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
      function send() {
        const msg = input.value.trim();
        if (!msg) return;
        chat.textContent += '\\n\\n> ' + msg + '\\n\\n';
        input.value = '';
        vscode.postMessage({ type: 'send', message: msg });
      }
      window.addEventListener('message', e => {
        if (e.data?.type === 'token') chat.textContent += e.data.text;
        if (e.data?.type === 'done') chat.textContent += '\\n';
      });
    </script>
  </body></html>`;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type !== 'send') return;
    const token = await getToken(context);
    if (!token) {
      panel.webview.postMessage({ type: 'token', text: '[set token via CodeRover: Set API Token]' });
      return;
    }
    try {
      const res = await fetch(apiBase() + '/copilot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream' },
        body: JSON.stringify({ message: msg.message }),
      });
      if (!res.body) {
        panel.webview.postMessage({ type: 'token', text: '[no response body]' });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Naive SSE: split on double-newline, ignore non-data frames
        const frames = buffer.split('\\n\\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          for (const line of frame.split('\\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const ev = JSON.parse(payload);
              if (typeof ev?.content === 'string') {
                panel.webview.postMessage({ type: 'token', text: ev.content });
              }
            } catch { /* non-JSON keepalive */ }
          }
        }
      }
      panel.webview.postMessage({ type: 'done' });
    } catch (err) {
      panel.webview.postMessage({ type: 'token', text: '\\n[error: ' + (err?.message || err) + ']' });
    }
  });
}

async function reviewPrCommand(context) {
  const token = await getToken(context);
  if (!token) { vscode.window.showWarningMessage('Set CodeRover API token first.'); return; }

  const prInput = await vscode.window.showInputBox({
    prompt: 'repo/name#PR (e.g. owner/repo#42)',
    ignoreFocusOut: true,
  });
  if (!prInput) return;
  const m = prInput.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (!m) { vscode.window.showErrorMessage('Format: owner/repo#42'); return; }
  const [, repo, prNumberStr] = m;
  const prNumber = parseInt(prNumberStr, 10);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `CodeRover: reviewing ${repo}#${prNumber}`, cancellable: false },
    async (progress) => {
      progress.report({ message: 'requesting review…' });
      try {
        const res = await fetch(apiBase() + '/pr-reviews/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ repo, prNumber }),
        });
        if (!res.ok) {
          vscode.window.showErrorMessage(`Review failed: ${res.status}`);
          return;
        }
        const result = await res.json();
        const findings = Array.isArray(result.findings) ? result.findings : [];
        if (!findings.length) {
          vscode.window.showInformationMessage(`CodeRover: no findings on ${repo}#${prNumber}`);
          return;
        }

        // Open a markdown view of findings
        const lines = [`# CodeRover Review: ${repo}#${prNumber}`, ''];
        if (result.summary) lines.push(result.summary, '');
        if (typeof result.score === 'number') lines.push(`**Score:** ${result.score}/10`, '');
        if (result.recommendation) lines.push(`**Recommendation:** ${result.recommendation}`, '');
        lines.push('', '## Findings', '');
        for (const f of findings) {
          lines.push(`### ${f.severity ?? 'note'}: ${f.title ?? f.file ?? 'untitled'}`);
          if (f.file) lines.push(`\`${f.file}${f.line ? ':' + f.line : ''}\``);
          if (f.body ?? f.description) lines.push('', f.body ?? f.description);
          lines.push('');
        }
        const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showErrorMessage(`CodeRover review error: ${err?.message || err}`);
      }
    },
  );
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coderover.setApiToken', () => setToken(context)),
    vscode.commands.registerCommand('coderover.search', () => searchCommand(context)),
    vscode.commands.registerCommand('coderover.chat', () => chatCommand(context)),
    vscode.commands.registerCommand('coderover.reviewPr', () => reviewPrCommand(context)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
