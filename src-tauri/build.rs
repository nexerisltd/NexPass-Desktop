fn main() {
    // Loads src-tauri/.env (gitignored, developer-local) if present, and
    // bakes these values into the compiled binary via env!() at compile
    // time. Nothing sensitive/project-identifying lives in this repo —
    // only in each developer's local .env (see .env.example).
    let _ = dotenvy::dotenv();
    for key in ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "FIREBASE_API_KEY", "FIRESTORE_PROJECT_ID"] {
        let val = std::env::var(key).unwrap_or_default();
        if val.is_empty() {
            println!("cargo:warning={key} is not set (create src-tauri/.env from .env.example) — sign-in/sync will not work in this build.");
        }
        println!("cargo:rustc-env={key}={val}");
    }
    println!("cargo:rerun-if-changed=.env");
    tauri_build::build()
}
