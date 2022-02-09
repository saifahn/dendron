import { IDendronExtension } from "./dendronExtensionInterface";
import vscode from "vscode";
import path from "path";
import {
  DendronError,
  DVault,
  NoteProps,
  NoteUtils,
  RespV3,
  VaultUtils,
} from "@dendronhq/common-all";
import _ from "lodash";
import { IWSUtilsV2 } from "./WSUtilsV2Interface";
import { Logger } from "./logger";
import { VSCodeUtils } from "./vsCodeUtils";
import { ExtensionProvider } from "./ExtensionProvider";
import { isInsidePath, vault2Path } from "@dendronhq/common-server";
import { WorkspaceUtils } from "@dendronhq/engine-server";

let WS_UTILS: IWSUtilsV2 | undefined;

/**
 *  Non static WSUtils to allow unwinding of our circular dependencies.
 *   */
export class WSUtilsV2 implements IWSUtilsV2 {
  private extension: IDendronExtension;

  constructor(extension: IDendronExtension) {
    this.extension = extension;
  }

  getVaultFromPath(fsPath: string): DVault {
    const { wsRoot, vaults } = this.extension.getDWorkspace();
    return VaultUtils.getVaultByFilePath({
      wsRoot,
      vaults,
      fsPath,
    });
  }

  getNoteFromPath(fsPath: string): NoteProps | undefined {
    const { engine, wsRoot } = this.extension.getDWorkspace();
    const fname = path.basename(fsPath, ".md");
    let vault: DVault;
    try {
      vault = this.getVaultFromPath(fsPath);
    } catch (err) {
      // No vault
      return undefined;
    }
    return NoteUtils.getNoteByFnameV5({
      fname,
      vault,
      wsRoot,
      notes: engine.notes,
    });
  }

  /**
   * Prefer NOT to use this method and instead get WSUtilsV2 passed in as
   * dependency or use IDendronExtension.wsUtils.
   *
   * This method exists to satisfy static method of WSUtils while refactoring
   * is happening and we are moving method to this class.
   * */
  static instance() {
    if (WS_UTILS === undefined) {
      WS_UTILS = new WSUtilsV2(ExtensionProvider.getExtension());
    }
    return WS_UTILS;
  }

  getVaultFromUri(fileUri: vscode.Uri): DVault {
    const { vaults } = this.extension.getDWorkspace();
    const vault = VaultUtils.getVaultByFilePath({
      fsPath: fileUri.fsPath,
      vaults,
      wsRoot: this.extension.getDWorkspace().wsRoot,
    });
    return vault;
  }

  getNoteFromDocument(document: vscode.TextDocument) {
    const { engine, wsRoot } = this.extension.getDWorkspace();
    const txtPath = document.uri.fsPath;
    const fname = path.basename(txtPath, ".md");
    let vault: DVault;
    try {
      vault = this.getVaultFromDocument(document);
    } catch (err) {
      // No vault
      return undefined;
    }
    return NoteUtils.getNoteByFnameV5({
      fname,
      vault,
      wsRoot,
      notes: engine.notes,
    });
  }

  /**
   * See {@link IWSUtilsV2.findNoteFromMultiVaultAsync}.
   */
  async findNoteFromMultiVaultAsync(opts: {
    fname: string;
    quickpickTitle: string;
    nonStubOnly?: boolean;
    vault?: DVault;
  }): Promise<RespV3<NoteProps | undefined>> {
    const { fname, quickpickTitle, nonStubOnly = false, vault } = opts;
    let existingNote: NoteProps | undefined;
    const engine = ExtensionProvider.getEngine();
    const maybeNotes = NoteUtils.getNotesByFnameFromEngine({
      fname,
      engine,
      vault,
    });

    const filteredNotes = nonStubOnly
      ? maybeNotes.filter((note) => !note.stub)
      : maybeNotes;

    if (filteredNotes.length === 1) {
      // Only one match so use that as note
      existingNote = filteredNotes[0];
    } else if (filteredNotes.length > 1) {
      // If there are multiple notes with this fname, prompt user to select which vault
      const vaults = filteredNotes.map((noteProps) => {
        return {
          vault: noteProps.vault,
          label: `${fname} from ${VaultUtils.getName(noteProps.vault)}`,
        };
      });

      const items = vaults.map((vaultPickerItem) => ({
        ...vaultPickerItem,
        label: vaultPickerItem.label
          ? vaultPickerItem.label
          : vaultPickerItem.vault.fsPath,
      }));
      const resp = await vscode.window.showQuickPick(items, {
        title: quickpickTitle,
      });

      if (!_.isUndefined(resp)) {
        existingNote = _.find(filteredNotes, { vault: resp.vault });
      } else {
        // If user escaped out of quickpick, then do not return error. Return undefined note instead
        return {
          data: existingNote,
        };
      }
    } else {
      return {
        error: new DendronError({
          message: `No note found for ${fname}`,
        }),
      };
    }
    return {
      data: existingNote,
    };
  }

  getVaultFromDocument(document: vscode.TextDocument) {
    const txtPath = document.uri.fsPath;
    const { wsRoot, vaults } = this.extension.getDWorkspace();
    const vault = VaultUtils.getVaultByFilePath({
      wsRoot,
      vaults,
      fsPath: txtPath,
    });
    return vault;
  }

  tryGetNoteFromDocument(document: vscode.TextDocument): NoteProps | undefined {
    const { wsRoot, vaults } = this.extension.getDWorkspace();
    if (
      !WorkspaceUtils.isPathInWorkspace({
        wsRoot,
        vaults,
        fpath: document.uri.fsPath,
      })
    ) {
      Logger.info({
        uri: document.uri.fsPath,
        msg: "not in workspace",
      });
      return;
    }
    try {
      const note = this.getNoteFromDocument(document);
      return note;
    } catch (err) {
      Logger.info({
        uri: document.uri.fsPath,
        msg: "not a valid note",
      });
    }
    return;
  }

  getActiveNote() {
    const editor = VSCodeUtils.getActiveTextEditor();
    if (editor) return this.getNoteFromDocument(editor.document);
    return;
  }

  /** If the text document at `filePath` is open in any editor, return that document. */
  getMatchingTextDocument(filePath: string): vscode.TextDocument | undefined {
    const { wsRoot } = this.extension.getDWorkspace();
    // Normalize file path for reliable comparison
    if (isInsidePath(wsRoot, filePath)) {
      filePath = path.relative(wsRoot, filePath);
    }
    return vscode.workspace.textDocuments.filter((document) => {
      let documentPath = document.uri.fsPath;
      if (isInsidePath(wsRoot, documentPath)) {
        documentPath = path.relative(wsRoot, documentPath);
      }
      return path.relative(filePath, documentPath) === "";
    })[0];
  }

  async openFileInEditorUsingFullFname(
    vault: DVault,
    fnameWithExtension: string
  ) {
    const wsRoot = this.extension.getDWorkspace().wsRoot;
    const vpath = vault2Path({ vault, wsRoot });
    const notePath = path.join(vpath, fnameWithExtension);
    const editor = await VSCodeUtils.openFileInEditor(
      vscode.Uri.file(notePath)
    );
    return editor as vscode.TextEditor;
  }

  async openNote(note: NoteProps) {
    const { vault, fname } = note;
    const fnameWithExtension = `${fname}.md`;
    return this.openFileInEditorUsingFullFname(vault, fnameWithExtension);
  }
}
