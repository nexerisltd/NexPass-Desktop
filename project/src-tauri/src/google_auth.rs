// NexPass — Google Sign-In via system browser (loopback redirect flow)
//
// Google blocks OAuth login inside embedded webviews, so this opens
// the user's default browser instead, catches the redirect on a
// temporary local server, then exchanges tokens with Google + Firebase.
//
// The browser is opened via Tauri's own `tauri-plugin-opener` rather
// than the `webbrowser` crate — it's the officially maintained,
// tested-on-mobile way to launch an external URL from a Tauri app
// (on Android this goes through a proper Intent via the app's JNI
// context, which a generic desktop-oriented crate isn't guaranteed to
// handle correctly).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::secrets::{GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FIREBASE_API_KEY};

#[derive(Serialize, Deserialize, Clone)]
pub struct FirebaseSession {
    pub id_token: String,
    pub refresh_token: String,
    pub email: String,
    pub local_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub photo_url: Option<String>,
}

pub fn sign_in_with_google(app: &AppHandle) -> Result<FirebaseSession, String> {
    let listener = TcpListener::bind("127.0.0.1:8721")
        .map_err(|e| format!("could not bind to port 8721 — is another instance already running? ({e})"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile&access_type=offline&prompt=consent",
        GOOGLE_CLIENT_ID, redirect_uri
    );

    app.opener()
        .open_url(auth_url, None::<&str>)
        .map_err(|e| format!("could not open browser: {e}"))?;

    let code = wait_for_redirect_code(&listener)?;
    let google_tokens = exchange_code_for_google_tokens(&code, &redirect_uri)?;
    exchange_id_token_for_firebase_session(&google_tokens.id_token)
}

fn wait_for_redirect_code(listener: &TcpListener) -> Result<String, String> {
    let (stream, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| e.to_string())?;

    let raw_code = request_line
        .split_whitespace()
        .nth(1)
        .and_then(|path| path.split("code=").nth(1))
        .and_then(|rest| rest.split('&').next())
        .ok_or_else(|| "no authorization code received".to_string())?;

    let code = urlencoding::decode(raw_code)
        .map_err(|e| format!("failed to decode auth code: {e}"))?
        .into_owned();

    respond_with_close_page(stream);
    Ok(code)
}

fn respond_with_close_page(mut stream: TcpStream) {
    let body = "<html><body style=\"font-family:sans-serif;text-align:center;margin-top:80px;\">\
        <h2>Signed in to NexPass</h2><p>You can close this tab and return to the app.</p>\
        </body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/html\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

#[derive(Deserialize)]
struct GoogleTokenResponse {
    id_token: String,
}

fn exchange_code_for_google_tokens(
    code: &str,
    redirect_uri: &str,
) -> Result<GoogleTokenResponse, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", GOOGLE_CLIENT_ID),
            ("client_secret", GOOGLE_CLIENT_SECRET),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "Google token exchange failed: {}",
            resp.text().unwrap_or_default()
        ));
    }

    resp.json::<GoogleTokenResponse>().map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct FirebaseSignInResponse {
    idToken: String,
    refreshToken: String,
    email: String,
    localId: String,
    #[serde(default)]
    displayName: Option<String>,
    #[serde(default)]
    photoUrl: Option<String>,
}

fn exchange_id_token_for_firebase_session(
    google_id_token: &str,
) -> Result<FirebaseSession, String> {
    let client = reqwest::blocking::Client::new();
    let url = format!(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key={}",
        FIREBASE_API_KEY
    );

    let post_body = format!("id_token={google_id_token}&providerId=google.com");
    let payload = serde_json::json!({
        "postBody": post_body,
        "requestUri": "http://localhost",
        "returnSecureToken": true
    });

    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!(
            "Firebase sign-in failed: {}",
            resp.text().unwrap_or_default()
        ));
    }

    let parsed: FirebaseSignInResponse = resp.json().map_err(|e| e.to_string())?;

    Ok(FirebaseSession {
        id_token: parsed.idToken,
        refresh_token: parsed.refreshToken,
        email: parsed.email,
        local_id: parsed.localId,
        display_name: parsed.displayName,
        photo_url: parsed.photoUrl,
    })
}
