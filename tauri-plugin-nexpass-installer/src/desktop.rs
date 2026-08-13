use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NexpassInstaller<R>> {
    Ok(NexpassInstaller(app.clone()))
}

/// Access to the nexpass-installer APIs.
pub struct NexpassInstaller<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NexpassInstaller<R> {
    pub fn install_apk(&self, payload: InstallApkRequest) -> crate::Result<InstallApkResponse> {
        // Desktop has no equivalent sandboxing problem — the OS's default
        // handler for the file works the same way it does for any other
        // local file, so this just hands it to the opener plugin.
        use tauri_plugin_opener::OpenerExt;
        self.0
            .opener()
            .open_path(payload.path, None::<&str>)
            .map_err(|e| crate::Error::Io(std::io::Error::other(e.to_string())))?;
        Ok(InstallApkResponse {})
    }
}
