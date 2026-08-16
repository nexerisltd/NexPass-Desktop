use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::NexpassInstallerExt;
use crate::Result;

#[command]
pub(crate) async fn install_apk<R: Runtime>(
    app: AppHandle<R>,
    payload: InstallApkRequest,
) -> Result<InstallApkResponse> {
    app.nexpass_installer().install_apk(payload)
}
