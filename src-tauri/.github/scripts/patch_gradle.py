#!/usr/bin/env python3
"""Patches src-tauri/gen/android/app/build.gradle.kts (freshly generated
by `tauri android init`) to add release signing config reading from
keystore.properties. Mirrors the manual edit used earlier in this
project — see the repo's chat history / README for context.
"""
import sys

PATH = "src-tauri/gen/android/app/build.gradle.kts"

with open(PATH) as f:
    content = f.read()

if "keystoreProperties" in content:
    print("Already patched, skipping.")
    sys.exit(0)

content = content.replace(
    "import java.util.Properties",
    "import java.util.Properties\nimport java.io.FileInputStream",
    1,
)

content = content.replace(
    "android {",
    '''val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }''',
    1,
)

content = content.replace(
    'getByName("release") {',
    'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")',
    1,
)

with open(PATH, "w") as f:
    f.write(content)

print("Patched build.gradle.kts")
