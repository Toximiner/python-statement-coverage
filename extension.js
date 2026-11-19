'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function reportPath(folder, config) {
  const configured = config.get('reportPath', '.vscode/coverage.xml');
  const absolute = path.resolve(folder.uri.fsPath, configured);
  if (fs.existsSync(absolute)) return absolute;
  const fallback = path.join(folder.uri.fsPath, 'coverage.xml');
  return configured === '.vscode/coverage.xml' && fs.existsSync(fallback) ? fallback : absolute;
}

function pythonPath(folder, config) {
  const root = folder.uri.fsPath;
  const substitute = value => value.replaceAll('${workspaceFolder}', root);
  const explicit = config.get('pythonPath', '');
  if (explicit) {
    const executable = substitute(explicit);
    return executable.includes(path.sep) ? path.resolve(root, executable) : executable;
  }
  const local = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(local)) return local;
  const configured = vscode.workspace.getConfiguration('python', folder.uri).get('defaultInterpreterPath', '');
  if (configured) {
    const candidate = substitute(configured);
    if (!candidate.includes(path.sep)) return candidate;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Python Statement Coverage');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'pythonStatementCoverage.toggle';
  const styles = new Map();
  let timer;
  let generation = 0;
  let stopped = false;
  let running;
  let latest = new Map();
  const watchers = [];
  context.subscriptions.push(output, status);

  function configFor(uri) {
    return vscode.workspace.getConfiguration('pythonStatementCoverage', uri);
  }
  function styleFor(uri) {
    const config = configFor(uri);
    const colors = {
      covered: config.get('coveredColor'),
      uncovered: config.get('uncoveredColor'),
      partial: config.get('partialColor'),
    };
    const key = JSON.stringify([colors, config.get('showRuler')]);
    if (!styles.has(key)) {
      const value = {};
      for (const [state, color] of Object.entries(colors)) {
        value[state] = vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: color,
          overviewRulerColor: config.get('showRuler') ? color : undefined,
          overviewRulerLane: vscode.OverviewRulerLane.Right,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        });
      }
      styles.set(key, value);
    }
    return styles.get(key);
  }
  function clear(editor) {
    for (const value of styles.values()) {
      for (const style of Object.values(value)) editor.setDecorations(style, []);
    }
  }
  function updateStatus() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') return status.hide();
    const enabled = configFor(editor.document.uri).get('enabled');
    const result = latest.get(editor.document.uri.fsPath);
    const notes = {
      missing: 'This file is absent from the coverage report.',
      noReport: 'No XML report found. Run tests with coverage and an XML report.',
      stale: 'Source was saved after the report. Run tests with coverage again.',
      dirty: 'Coverage hidden while the file has unsaved changes.',
      error: 'Cannot read coverage. See Python Statement Coverage output.',
    };
    status.text = '$(beaker) Coverage: ' + (!enabled ? 'off' : result?.status === 'ok'
      ? `${result.total ? Math.round(100 * result.covered / result.total) : 100}%` : '—');
    status.tooltip = !enabled ? 'Click to enable statement coverage.' :
      result?.status === 'ok' ? 'Coverage of complete Python statements. Click to hide. Percentages use original report lines.' :
      notes[result?.status] || 'Waiting for coverage.';
    status.show();
  }

  function analyze(executable, request) {
    return new Promise((resolve, reject) => {
      const child = execFile(executable, [context.asAbsolutePath('analyzer.py')], {
        cwd: request.workspace, timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (running === child) running = undefined;
        if (error) return reject(new Error(stderr.trim() || error.message));
        try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
      });
      running = child;
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }

  async function refresh(id) {
    const folders = new Map();
    const results = new Map();
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      clear(editor);
      if (doc.languageId !== 'python' || doc.uri.scheme !== 'file') continue;
      if (doc.isDirty) { results.set(doc.uri.fsPath, { status: 'dirty' }); continue; }
      if (!configFor(doc.uri).get('enabled') || !vscode.workspace.isTrusted) continue;
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder) continue;
      if (!folders.has(folder.uri.fsPath)) folders.set(folder.uri.fsPath, { folder, files: new Set() });
      folders.get(folder.uri.fsPath).files.add(doc.uri.fsPath);
    }
    for (const { folder, files } of folders.values()) {
      if (stopped || id !== generation) return;
      const config = configFor(folder.uri);
      const report = reportPath(folder, config);
      if (!fs.existsSync(report)) {
        for (const file of files) results.set(file, { status: 'noReport' });
        continue;
      }
      try {
        const data = await analyze(pythonPath(folder, config), {
          workspace: folder.uri.fsPath, report, files: [...files], hideStale: config.get('hideStale'),
          fillBlankLines: config.get('fillBlankLines', true),
        });
        for (const [file, result] of Object.entries(data)) {
          results.set(file, result);
          if (result.error) output.appendLine(`${file}: ${result.error}`);
        }
      } catch (error) {
        if (id !== generation || stopped) return;
        output.appendLine(error.message);
        for (const file of files) results.set(file, { status: 'error' });
      }
    }
    if (stopped || id !== generation) return;
    latest = results;
    for (const editor of vscode.window.visibleTextEditors) {
      const result = results.get(editor.document.uri.fsPath);
      if (editor.document.isDirty || result?.status !== 'ok' || !configFor(editor.document.uri).get('enabled')) continue;
      const decorations = { covered: [], uncovered: [], partial: [] };
      for (const range of result.ranges) {
        if (range.start < 1 || range.end > editor.document.lineCount) continue;
        const label = { covered: 'Covered', uncovered: 'Uncovered', partial: 'Partially covered branches' }[range.state];
        decorations[range.state].push({
          range: new vscode.Range(range.start - 1, 0, range.end - 1, editor.document.lineAt(range.end - 1).text.length),
          hoverMessage: `${label} — report line ${range.anchor}. Continuation lines share the statement's status; they are not independently measured.`,
        });
      }
      const types = styleFor(editor.document.uri);
      for (const state of Object.keys(types)) editor.setDecorations(types[state], decorations[state]);
    }
    updateStatus();
  }

  function schedule() {
    if (stopped) return;
    const id = ++generation;
    if (running) running.kill();
    clearTimeout(timer);
    timer = setTimeout(() => refresh(id).catch(error => output.appendLine(error.message)), 250);
  }
  function watchReports() {
    for (const watcher of watchers.splice(0)) watcher.dispose();
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const configured = configFor(folder.uri).get('reportPath', '.vscode/coverage.xml');
      const absolute = path.resolve(folder.uri.fsPath, configured);
      const targets = new Set([absolute, path.join(folder.uri.fsPath, 'coverage.xml')]);
      for (const target of targets) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(target), path.basename(target)));
        watcher.onDidChange(schedule);
        watcher.onDidCreate(schedule);
        watcher.onDidDelete(schedule);
        watchers.push(watcher);
      }
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('pythonStatementCoverage.toggle', async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const config = configFor(uri);
      const target = uri && vscode.workspace.getWorkspaceFolder(uri)
        ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
      await config.update('enabled', !config.get('enabled'), target);
    }),
    vscode.commands.registerCommand('pythonStatementCoverage.refresh', schedule),
    vscode.commands.registerCommand('pythonStatementCoverage.output', () => output.show()),
    vscode.window.onDidChangeVisibleTextEditors(schedule),
    vscode.window.onDidChangeActiveTextEditor(() => { updateStatus(); schedule(); }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId !== 'python') return;
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === event.document) clear(editor);
      }
      schedule();
    }),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { watchReports(); schedule(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('pythonStatementCoverage') || event.affectsConfiguration('python.defaultInterpreterPath')) {
        for (const value of styles.values()) for (const style of Object.values(value)) style.dispose();
        styles.clear();
        watchReports();
        schedule();
      }
    }),
    { dispose() {
      stopped = true; ++generation; clearTimeout(timer); running?.kill();
      for (const watcher of watchers) watcher.dispose();
      for (const value of styles.values()) for (const style of Object.values(value)) style.dispose();
    } },
  );
  watchReports();
  schedule();
  return { refresh: () => refresh(++generation) };
}

module.exports = { activate, reportPath, pythonPath };
