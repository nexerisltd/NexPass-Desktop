#!/usr/bin/env python3
"""Patches the Tauri-generated Android project (run AFTER `tauri android
init`, same as patch_gradle.py) so a downloaded update APK can actually be
installed.

Why this is needed: the APK is downloaded into NexPass's own private
storage (see updater.rs), and Android's package installer — a different
app — cannot read a file straight out of another app's private storage via
a plain file path. It needs a FileProvider content:// URI with an explicit
read-permission grant. That's three small, standard Android pieces:

  1. AndroidManifest.xml — REQUEST_INSTALL_PACKAGES permission + a
     FileProvider <provider> entry.
  2. res/xml/file_paths.xml — tells the FileProvider which private folder
     it's allowed to serve ("updates/", matching updater.rs's storage dir).
  3. MainActivity.kt — an installApk(path) method that builds the
     FileProvider URI and fires the install Intent. Rust calls this over
     JNI (see src-tauri/src/installer.rs) since there's no plugin API for
     it — the opener plugin doesn't do this FileProvider step, which is
     exactly why installing used to silently do nothing.

Safe to re-run — every step checks whether it's already applied first.
"""
import glob
import os
import re
import sys

ANDROID_DIR = "src-tauri/gen/android"
MANIFEST_PATH = f"{ANDROID_DIR}/app/src/main/AndroidManifest.xml"
FILE_PATHS_DIR = f"{ANDROID_DIR}/app/src/main/res/xml"
FILE_PATHS_PATH = f"{FILE_PATHS_DIR}/file_paths.xml"

PROVIDER_BLOCK = """        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>
"""

INSTALL_APK_METHOD = """
    // Hands a downloaded update APK to Android's own package installer via
    // a FileProvider content:// URI (a raw file:// path to our private
    // storage isn't readable by the installer — see updater.rs for why the
    // APK lives in app-private storage in the first place). If NexPass
    // doesn't yet have the "install unknown apps" permission for this
    // source, the installer screen itself prompts for it — nothing else
    // needed here. Called from Rust over JNI (installer.rs).
    //
    // Returns "OK" or "ERROR: ..." instead of being void/throwing: letting
    // a Kotlin exception cross the JNI boundary uncaught is a real crash
    // risk (any JNI call made before a pending exception is cleared is
    // undefined behavior), so every failure is caught here and reported as
    // a normal return value instead.
    fun installApk(path: String): String {
        return try {
            val file = java.io.File(path)
            val uri = androidx.core.content.FileProvider.getUriForFile(
                this,
                "$packageName.fileprovider",
                file
            )
            val intent = android.content.Intent(android.content.Intent.ACTION_VIEW)
            intent.setDataAndType(uri, "application/vnd.android.package-archive")
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivity(intent)
            "OK"
        } catch (e: Exception) {
            "ERROR: ${e.javaClass.simpleName}: ${e.message}"
        }
    }
"""


def patch_manifest():
    if not os.path.exists(MANIFEST_PATH):
        print(f"Not found: {MANIFEST_PATH} — run `tauri android init` first.", file=sys.stderr)
        sys.exit(1)

    with open(MANIFEST_PATH) as f:
        content = f.read()
    original = content

    if "REQUEST_INSTALL_PACKAGES" not in content:
        content = content.replace(
            "<application",
            '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n\n    <application',
            1,
        )

    if "fileprovider" not in content:
        content = content.replace("</application>", PROVIDER_BLOCK + "    </application>", 1)

    if content != original:
        with open(MANIFEST_PATH, "w") as f:
            f.write(content)
        print(f"Patched {MANIFEST_PATH}")
    else:
        print("AndroidManifest.xml already patched, skipping.")


def write_file_paths():
    os.makedirs(FILE_PATHS_DIR, exist_ok=True)
    if os.path.exists(FILE_PATHS_PATH):
        print("file_paths.xml already exists, skipping.")
        return
    with open(FILE_PATHS_PATH, "w") as f:
        f.write(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<paths>\n"
            '    <files-path name="updates" path="updates/" />\n'
            '    <cache-path name="updates_cache" path="updates/" />\n'
            "    <!-- Tauri's app_data_dir() resolution on Android has been\n"
            "         inconsistent across versions (tauri-apps/tauri#12276) —\n"
            "         this root-path is a deliberately broad fallback so\n"
            "         FileProvider still resolves the APK wherever it actually\n"
            "         landed, rather than failing with 'no configured root'. -->\n"
            '    <root-path name="root" path="." />\n'
            "</paths>\n"
        )
    print(f"Wrote {FILE_PATHS_PATH}")


def patch_main_activity():
    matches = glob.glob(f"{ANDROID_DIR}/app/src/main/java/**/MainActivity.kt", recursive=True)
    if not matches:
        print("MainActivity.kt not found — is the Android project generated yet?", file=sys.stderr)
        sys.exit(1)
    path = matches[0]

    with open(path) as f:
        content = f.read()

    if "installApk" in content:
        print(f"{path} already patched, skipping.")
        return

    match = re.search(r"class\s+MainActivity\s*:\s*TauriActivity\(\)\s*\{", content)
    if not match:
        print(
            f"Couldn't find 'class MainActivity : TauriActivity() {{' in {path} — "
            "add this method to the class body manually:",
            file=sys.stderr,
        )
        print(INSTALL_APK_METHOD, file=sys.stderr)
        sys.exit(1)

    insert_at = match.end()
    content = content[:insert_at] + INSTALL_APK_METHOD + content[insert_at:]

    with open(path, "w") as f:
        f.write(content)
    print(f"Patched {path}")


if __name__ == "__main__":
    patch_manifest()
    write_file_paths()
    patch_main_activity()
