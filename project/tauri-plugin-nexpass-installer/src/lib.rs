use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::NexpassInstaller;
#[cfg(mobile)]
use mobile::NexpassInstaller;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the nexpass-installer APIs.
pub trait NexpassInstallerExt<R: Runtime> {
  fn nexpass_installer(&self) -> &NexpassInstaller<R>;
}

impl<R: Runtime, T: Manager<R>> crate::NexpassInstallerExt<R> for T {
  fn nexpass_installer(&self) -> &NexpassInstaller<R> {
    self.state::<NexpassInstaller<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("nexpass-installer")
    .invoke_handler(tauri::generate_handler![commands::install_apk])
    .setup(|app, api| {
      #[cfg(mobile)]
      let nexpass_installer = mobile::init(app, api)?;
      #[cfg(desktop)]
      let nexpass_installer = desktop::init(app, api)?;
      app.manage(nexpass_installer);
      Ok(())
    })
    .build()
}
