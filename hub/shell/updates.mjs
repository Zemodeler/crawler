/** No release authority is configured. Never infer one from package metadata. */
export const MANUAL_UPDATE = "Automatic update checking is unavailable: no trusted release target is configured. Obtain a new build directly from your maintainer and verify its source and checksum. Quit Study Hub from the tray/menu bar before replacing the app. Keep the previous installer for recovery. Your My Studies library and Study Hub application data must be preserved.";

export async function showUpdateInstructions({ dialog, version }) {
  await dialog.showMessageBox({
    type: "info", title: "Update Study Hub", buttons: ["OK"],
    message: `Study Hub ${version}`, detail: MANUAL_UPDATE,
  });
}
