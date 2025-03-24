import * as vscode from "vscode";

function normalizePath(uri: vscode.Uri): string {
  if (uri.scheme === "git") {
    return uri.path;
  }
  if (uri.scheme === "file") {
    return uri.fsPath;
  }
  return uri.toString();
}

const lineMap = new Map<string, number>();

vscode.window.onDidChangeTextEditorSelection((e) => {
  const line = e.selections[0]?.active.line;
  const key = normalizePath(e.textEditor.document.uri);
  lineMap.set(key, line);
  console.log(`[cursorghost] 📝 Saved line ${line} for ${key}`);
});

vscode.window.onDidChangeActiveTextEditor((editor) => {
  if (!editor) {
    return;
  }

  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const isDiffEditor = activeTab?.input instanceof vscode.TabInputTextDiff;

  if (!isDiffEditor) {
    console.log(`[cursorghost] 🚫 Not a diff editor, skipping`);
    return;
  }

  const key = normalizePath(editor.document.uri);
  const line = lineMap.get(key);
  if (line !== undefined) {
    setTimeout(() => {
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
      console.log(`[cursorghost] 🔄 Restored line ${line} for ${key}`);
    }, 0);
  }
});

export function deactivate() {}
