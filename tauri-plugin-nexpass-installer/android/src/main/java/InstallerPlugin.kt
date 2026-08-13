package com.nexapp.nexpass.installer

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke

@InvokeArg
class InstallApkArgs {
    var path: String? = null
}

// Hands a downloaded update APK to Android's own package installer via a
// FileProvider content:// URI (a raw file:// path to NexPass's private
// storage isn't readable by the installer — see updater.rs on the main
// app side for why the APK lives in app-private storage in the first
// place). If NexPass doesn't yet have the "install unknown apps"
// permission for this source, the installer screen itself prompts for
// it — nothing else needed here.
//
// This runs as a real Tauri plugin command (not raw JNI) because that's
// the only mechanism Tauri actually initializes the Android context for.
@TauriPlugin
class InstallerPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun installApk(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallApkArgs::class.java)
            val path = args.path
            if (path == null) {
                invoke.reject("path is required")
                return
            }
            val file = java.io.File(path)
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file
            )
            val intent = Intent(Intent.ACTION_VIEW)
            intent.setDataAndType(uri, "application/vnd.android.package-archive")
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(intent)
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject("${e.javaClass.simpleName}: ${e.message}")
        }
    }
}
