use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_nexpass_installer);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<NexpassInstaller<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.nexapp.nexpass.installer", "InstallerPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_nexpass_installer)?;
    Ok(NexpassInstaller(handle))
}

/// Access to the nexpass-installer APIs.
pub struct NexpassInstaller<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> NexpassInstaller<R> {
    pub fn install_apk(&self, payload: InstallApkRequest) -> crate::Result<InstallApkResponse> {
        self.0
            .run_mobile_plugin("installApk", payload)
            .map_err(Into::into)
    }
}
