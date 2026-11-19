'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('editor integration uses real Python analyzer, paints complete statements, clears dirty and disabled files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-coverage-'));
  const filename = path.join(root, 'example.py');
  const report = path.join(root, 'coverage.xml');
  const source = 'def fn(\n    value,\n):\n    return {\n        "key": value,\n    }\n';
  fs.writeFileSync(filename, source);
  fs.writeFileSync(report, '<coverage><sources><source>' + root + '</source></sources><packages><package><classes>' +
    '<class filename="example.py"><lines><line number="1" hits="1"/><line number="4" hits="0"/></lines></class>' +
    '</classes></package></packages></coverage>');
  const values = { enabled: true, reportPath: 'coverage.xml', pythonPath: 'python3', hideStale: true,
    coveredColor: '#00800080', uncoveredColor: '#ff000080', partialColor: '#ffff0080', showRuler: true };
  const callbacks = {};
  const commands = {};
  const listeners = name => callback => { callbacks[name] = callback; return { dispose() {} }; };
  const uri = { fsPath: filename, scheme: 'file' };
  const decorations = new Map();
  const errors = [];
  const doc = { uri, languageId: 'python', isDirty: false, lineCount: 7,
    lineAt: number => ({ text: source.split('\n')[number] }) };
  const editor = { document: doc, setDecorations: (style, ranges) => decorations.set(style.options.backgroundColor, ranges) };
  const status = { text: '', show() {}, hide() {}, dispose() {} };
  const folder = { uri: { fsPath: root } };
  const mock = {
    window: { visibleTextEditors: [editor], activeTextEditor: editor,
      createOutputChannel: () => ({ appendLine: text => errors.push(text), dispose() {} }),
      createStatusBarItem: () => status,
      createTextEditorDecorationType: options => ({ options, dispose() {} }),
      onDidChangeVisibleTextEditors: listeners('visible'), onDidChangeActiveTextEditor: listeners('active') },
    workspace: { isTrusted: true, workspaceFolders: [folder], getWorkspaceFolder: () => folder,
      getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback,
        update: async (key, value) => { values[key] = value; callbacks.config({ affectsConfiguration: () => true }); } }),
      createFileSystemWatcher: () => ({ onDidChange: listeners('report'), onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeTextDocument: listeners('edit'), onDidSaveTextDocument: listeners('save'),
      onDidChangeWorkspaceFolders: listeners('folders'), onDidChangeConfiguration: listeners('config') },
    commands: { registerCommand: (name, callback) => { commands[name] = callback; return { dispose() {} }; } },
    Range: class { constructor(start, startCol, end, endCol) { this.start = start; this.end = end; this.endCol = endCol; } },
    RelativePattern: class {}, StatusBarAlignment: { Right: 1 }, OverviewRulerLane: { Right: 1 },
    DecorationRangeBehavior: { ClosedClosed: 1 }, ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2 },
  };
  const original = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
  let extension;
  try { extension = require('../extension'); } finally { Module._load = original; }
  const context = { subscriptions: [], asAbsolutePath: name => path.join(__dirname, '..', name) };
  try {
    const api = extension.activate(context);
    await api.refresh();
    assert.deepEqual(errors, []);
    const green = decorations.get(values.coveredColor), red = decorations.get(values.uncoveredColor);
    assert.equal(green[0].range.start, 0);
    assert.equal(green[0].range.end, 2);
    assert.equal(red[0].range.start, 3);
    assert.equal(red[0].range.end, 5);
    assert.ok(red[0].hoverMessage.includes('report line 4'));
    assert.ok(status.text.includes('50%'));
    doc.isDirty = true;
    callbacks.edit({ document: doc });
    assert.deepEqual(decorations.get(values.coveredColor), []);
    await api.refresh();
    assert.ok(status.tooltip.includes('unsaved'));
    doc.isDirty = false;
    await commands['pythonStatementCoverage.toggle']();
    assert.equal(values.enabled, false);
    await api.refresh();
    assert.ok(status.text.includes('off'));
    assert.deepEqual(decorations.get(values.uncoveredColor), []);
  } finally {
    for (const item of context.subscriptions.toReversed()) item.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
