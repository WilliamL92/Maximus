import * as vscode from 'vscode';
import { MaximusEditorProvider } from './customEditor';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(MaximusEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('maximus.openWith', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage('No file selected.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, MaximusEditorProvider.viewType);
    })
  );
}

export function deactivate() {}
