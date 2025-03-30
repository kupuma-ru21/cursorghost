import * as vscode from "vscode";
import {diffLines} from "diff";
import * as cp from "child_process";
import * as path from "path";

const lineMap = new Map<string, number>();

function normalizePath(uri: vscode.Uri): string {
  if (uri.scheme === "git") {
    return uri.path;
  }
  if (uri.scheme === "file") {
    return uri.fsPath;
  }
  return uri.toString();
}

vscode.window.onDidChangeTextEditorSelection((e) => {
  const line = e.selections[0]?.active.line;
  const key = normalizePath(e.textEditor.document.uri);
  if (typeof line === "number") {
    lineMap.set(key, line);
  }
});

vscode.window.onDidChangeActiveTextEditor(async (editor) => {
  if (!editor) {
    return;
  }

  const key = normalizePath(editor.document.uri);
  const savedLine = lineMap.get(key);
  if (savedLine === undefined) {
    return;
  }

  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const isDiffEditor = activeTab?.input instanceof vscode.TabInputTextDiff;
  if (isDiffEditor) {
    const cursorLine = editor.selection.active.line;
    lineMap.set(key, cursorLine);
  }

  const editors = vscode.window.visibleTextEditors;
  const [leftEditor, rightEditor] = editors;
  if (!leftEditor || !rightEditor) {
    return;
  }

  const isRight = editor === rightEditor;
  const leftText = leftEditor.document.getText();
  const rightText = rightEditor.document.getText();

  const changes = diffLines(leftText, rightText);
  let leftLine = 0;
  let rightLine = 0;
  const mapRightToLeft: Record<number, number> = {};
  const mapLeftToRight: Record<number, number> = {};

  for (const change of changes) {
    const lines = change.value.split("\n");
    lines.pop();

    for (let i = 0; i < lines.length; i++) {
      if (!change.added && !change.removed) {
        mapRightToLeft[rightLine] = leftLine;
        mapLeftToRight[leftLine] = rightLine;
        leftLine++;
        rightLine++;
      } else if (change.added) {
        rightLine++;
      } else if (change.removed) {
        leftLine++;
      }
    }
  }

  const mappedLine = isRight
    ? mapLeftToRight[savedLine]
    : mapRightToLeft[savedLine];

  if (mappedLine !== undefined) {
    setTimeout(() => {
      const pos = new vscode.Position(mappedLine, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    }, 0);
  } else {
    const filePath = editor.document.uri.fsPath;
    const fallbackLine = isRight
      ? await getMappedContextLineInNewFile(filePath, savedLine)
      : await getNearestUnchangedLineAbove(filePath, savedLine);

    if (fallbackLine !== undefined) {
      setTimeout(() => {
        const pos = new vscode.Position(fallbackLine, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        );
      }, 0);
    }
  }
});

function getNearestUnchangedLineAbove(
  filePath: string,
  targetLine: number
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.file(filePath)
    );
    if (!workspaceFolder) {
      return reject(new Error("File is not in the workspace."));
    }

    const cwd = workspaceFolder.uri.fsPath;
    const relativePath = path.relative(cwd, filePath);

    cp.exec(
      `git diff --unified=1000 -- ${relativePath}`,
      {cwd},
      (err, stdout) => {
        if (err) {
          return reject(err);
        }

        const lines = stdout.split("\n");
        let currentLineInNew = 0;
        let ignoreBlankContextLines = true;

        for (const line of lines) {
          if (line.startsWith("+") && line.trim() === "+") {
            ignoreBlankContextLines = false;
            break;
          }
        }

        let latestContextInHunk: number | undefined = undefined;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
          if (match) {
            currentLineInNew = parseInt(match[1], 10) - 1;
            latestContextInHunk = undefined;
            continue;
          }

          if (line.startsWith("+") && !line.startsWith("+++")) {
            if (currentLineInNew === targetLine) {
              return resolve(latestContextInHunk);
            }
            currentLineInNew++;
          } else if (line.startsWith(" ")) {
            const isBlank = line.trim() === "";

            if (isBlank && ignoreBlankContextLines) {
              currentLineInNew++;
              continue;
            }

            if (!isBlank) {
              latestContextInHunk = currentLineInNew;
            }

            currentLineInNew++;
          } else if (line.startsWith("-")) {
            continue;
          }
        }

        resolve(undefined);
      }
    );
  });
}

function getMappedContextLineInNewFile(
  filePath: string,
  targetLine: number
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.file(filePath)
    );
    if (!workspaceFolder) {
      return reject(new Error("File is not in the workspace."));
    }

    const cwd = workspaceFolder.uri.fsPath;
    const relativePath = path.relative(cwd, filePath);

    cp.exec(
      `git diff --unified=1000 -- ${relativePath}`,
      {cwd},
      (err, stdout) => {
        if (err) {
          return reject(err);
        }

        const lines = stdout.split("\n");
        let currentLineOld = 0;
        let currentLineNew = 0;
        let latestContextOld: number | undefined = undefined;
        const mapOldToNew: Record<number, number> = {};
        let ignoreBlankContextLines = true;

        for (const line of lines) {
          if (line.startsWith("+") && line.trim() === "+") {
            ignoreBlankContextLines = false;
            break;
          }
        }

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          const match = line.match(
            /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
          );
          if (match) {
            currentLineOld = parseInt(match[1], 10) - 1;
            currentLineNew = parseInt(match[3], 10) - 1;
            latestContextOld = undefined;
            continue;
          }

          if (line.startsWith("-") && !line.startsWith("---")) {
            if (currentLineOld === targetLine) {
              if (latestContextOld !== undefined) {
                const mapped = mapOldToNew[latestContextOld];
                return resolve(mapped);
              } else {
                return resolve(undefined);
              }
            }
            currentLineOld++;
          } else if (line.startsWith("+") && !line.startsWith("+++")) {
            currentLineNew++;
          } else if (line.startsWith(" ")) {
            const isBlank = line.trim() === "";

            if (isBlank && ignoreBlankContextLines) {
              currentLineOld++;
              currentLineNew++;
              continue;
            }

            mapOldToNew[currentLineOld] = currentLineNew;

            if (!isBlank) {
              latestContextOld = currentLineOld;
            }

            currentLineOld++;
            currentLineNew++;
          }
        }

        return resolve(undefined);
      }
    );
  });
}

export function deactivate() {}
