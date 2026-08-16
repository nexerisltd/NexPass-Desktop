// Fires off installation of a downloaded update APK.
//
// Why this exists instead of just calling the opener plugin's openPath()
// from the frontend: tauri-plugin-opener does NOT wrap local app-owned
// file paths in a FileProvider content:// URI on Android (a known gap —
// see https://github.com/tauri-apps/plugins-workspace/issues/2383). Since
// updater.rs deliberately keeps the downloaded APK in NexPass's own
// private storage (so "Delete APK File" behaves predictably — see the
// comment there), Android's package installer — a *different* app —
// has no permission to read it from a plain file path. Handing it a raw
// path silently fails with "no Activity found to handle Intent", which
// is exactly the symptom of calling openPath() directly here.
//
// The fix is the standard Android one: wrap the file in a FileProvider
// content:// URI and grant the installer read access to just that URI.
// That requires a couple of lines of real Android code, which is why
// MainActivity.kt gets a small `installApk(path)` method (added by
// .github/scripts/patch_android_installer.py after `tauri android init`)
// — this module's only job on Android is to call into it over JNI.
use tauri::AppHandle;

#[cfg(target_os = "android")]
pub fn install_apk(_app: &AppHandle, path: &str) -> Result<(), String> {
    use jni::objects::{JObject, JString, JValue};
    use jni::JavaVM;

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    // Safety: ctx.context() is the app's current Activity object for as
    // long as the process is alive, which is guaranteed while this
    // (synchronous, called-from-a-command) function runs.
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };

    let jpath = env.new_string(path).map_err(|e| e.to_string())?;
    // installApk() returns a String ("OK" / "ERROR: ...") rather than being
    // void — MainActivity.kt catches its own exceptions and reports them
    // this way deliberately. Letting a Kotlin exception cross the JNI
    // boundary uncaught is a real crash risk (any JNI call made before the
    // pending exception is cleared is undefined behavior), so keeping every
    // possible failure inside a normal Kotlin return value sidesteps that
    // entirely instead of relying on getting JNI exception-handling exactly
    // right.
    let result = env
        .call_method(&activity, "installApk", "(Ljava/lang/String;)Ljava/lang/String;", &[JValue::Object(&jpath)])
        .map_err(|e| format!("installApk JNI call failed: {e}"))?;

    let jresult: JString = result.l().map_err(|e| e.to_string())?.into();
    let rust_result: String = env.get_string(&jresult).map_err(|e| e.to_string())?.into();

    if rust_result == "OK" {
        Ok(())
    } else {
        Err(rust_result)
    }
}

#[cfg(not(target_os = "android"))]
pub fn install_apk(app: &AppHandle, path: &str) -> Result<(), String> {
    // Desktop has no equivalent sandboxing problem — the OS's default
    // handler for the file works the same way it does for any other
    // local file.
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}
