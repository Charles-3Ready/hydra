use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use uuid::Uuid;

const BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing";
const BILLING_CREDITS_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Profile {
    id: String,
    name: String,
    email: Option<String>,
    raw_auth_json: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProfileStore {
    profiles: Vec<Profile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileView {
    id: String,
    name: String,
    email: Option<String>,
    is_active: bool,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginStatus {
    exists: bool,
    fingerprint: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageView {
    profile_id: String,
    used: Option<f64>,
    limit: Option<f64>,
    percent: Option<f64>,
    label: String,
    period_label: Option<String>,
    resets_at: Option<String>,
    source: String,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrokInstance {
    pid: u32,
}

fn config_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Unable to locate the home directory")?;
    let dir = home.join(".hydra");
    // One-time migration: earlier builds stored profiles under the trademark-bearing
    // ~/.grok-hydra name. Move it to ~/.hydra on first run under the new build so
    // existing saved profiles survive the rename instead of silently disappearing.
    let legacy = home.join(".grok-hydra");
    if !dir.exists() && legacy.exists() {
        let _ = fs::rename(&legacy, &dir);
    }
    Ok(dir)
}

fn store_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("profiles.json"))
}

fn live_auth_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Unable to locate the home directory")?;
    Ok(home.join(".grok").join("auth.json"))
}

fn load_store() -> Result<ProfileStore, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(ProfileStore::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_str(&content).map_err(|error| format!("Profile store is invalid: {error}"))
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let temp = path.with_extension("tmp");
    fs::write(&temp, content)
        .map_err(|error| format!("Could not write {}: {error}", temp.display()))?;
    if path.exists() {
        let backup = path.with_extension("backup");
        let _ = fs::copy(path, backup);
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace {}: {error}", path.display()))?;
    }
    fs::rename(&temp, path)
        .map_err(|error| format!("Could not finalize {}: {error}", path.display()))
}

fn save_store(store: &ProfileStore) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("Could not serialize profiles: {error}"))?;
    atomic_write(&store_path()?, &payload)
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize(&object[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

fn normalized_auth(raw: &str) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|error| format!("Invalid auth JSON: {error}"))?;
    serde_json::to_string(&canonicalize(&value))
        .map_err(|error| format!("Could not normalize auth JSON: {error}"))
}

fn fingerprint(raw: &str) -> Result<String, String> {
    let normalized = normalized_auth(raw)?;
    Ok(hex::encode(Sha256::digest(normalized.as_bytes())))
}

fn find_string_by_keys(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(Value::String(value)) = object.get(*key) {
                    if !value.trim().is_empty() {
                        return Some(value.clone());
                    }
                }
            }
            object
                .values()
                .find_map(|child| find_string_by_keys(child, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| find_string_by_keys(child, keys)),
        _ => None,
    }
}

fn auth_email(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    find_string_by_keys(&value, &["email", "preferred_username"])
}

fn access_token(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    find_string_by_keys(&value, &["access_token", "key", "token"]).filter(|token| token.len() > 40)
}

fn read_live_auth() -> Result<Option<String>, String> {
    let path = live_auth_path()?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))
}

fn profile_view(profile: &Profile, live_fingerprint: Option<&str>) -> ProfileView {
    let profile_fingerprint = fingerprint(&profile.raw_auth_json).ok();
    ProfileView {
        id: profile.id.clone(),
        name: profile.name.clone(),
        email: profile.email.clone(),
        is_active: profile_fingerprint.as_deref() == live_fingerprint,
        created_at: profile.created_at,
        last_used_at: profile.last_used_at,
    }
}

fn upsert_auth(raw: String, requested_name: Option<String>) -> Result<ProfileView, String> {
    normalized_auth(&raw)?;
    let email = auth_email(&raw);
    let raw_fingerprint = fingerprint(&raw)?;
    let mut store = load_store()?;
    let existing = store.profiles.iter_mut().find(|profile| {
        fingerprint(&profile.raw_auth_json).ok().as_deref() == Some(raw_fingerprint.as_str())
            || (email.is_some() && profile.email == email)
    });

    let id = if let Some(profile) = existing {
        profile.raw_auth_json = raw;
        profile.email = email.clone();
        profile.last_used_at = Some(Utc::now());
        if let Some(name) = requested_name.filter(|name| !name.trim().is_empty()) {
            profile.name = name.trim().to_string();
        }
        profile.id.clone()
    } else {
        let id = Uuid::new_v4().to_string();
        let name = requested_name
            .filter(|name| !name.trim().is_empty())
            .or_else(|| email.clone())
            .unwrap_or_else(|| format!("Profile {}", store.profiles.len() + 1));
        store.profiles.push(Profile {
            id: id.clone(),
            name,
            email: email.clone(),
            raw_auth_json: raw,
            created_at: Utc::now(),
            last_used_at: Some(Utc::now()),
        });
        id
    };
    save_store(&store)?;
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .ok_or("Imported profile was not found")?;
    Ok(profile_view(profile, Some(&raw_fingerprint)))
}

#[tauri::command]
fn list_profiles() -> Result<Vec<ProfileView>, String> {
    let store = load_store()?;
    let live_fingerprint = read_live_auth()?
        .as_deref()
        .and_then(|raw| fingerprint(raw).ok());
    Ok(store
        .profiles
        .iter()
        .map(|profile| profile_view(profile, live_fingerprint.as_deref()))
        .collect())
}

#[tauri::command]
fn login_status() -> Result<LoginStatus, String> {
    let raw = read_live_auth()?;
    Ok(LoginStatus {
        exists: raw.is_some(),
        fingerprint: raw.as_deref().and_then(|value| fingerprint(value).ok()),
        email: raw.as_deref().and_then(auth_email),
    })
}

#[tauri::command]
fn import_current_profile(name: Option<String>) -> Result<ProfileView, String> {
    let raw = read_live_auth()?.ok_or("Run grok login first; no auth.json was found")?;
    upsert_auth(raw, name)
}

#[tauri::command]
fn import_profile_file(path: String, name: Option<String>) -> Result<ProfileView, String> {
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read selected auth file: {error}"))?;
    upsert_auth(raw, name)
}

#[cfg(target_os = "windows")]
fn parse_tasklist_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                fields.push(field.clone());
                field.clear();
            }
            _ => field.push(ch),
        }
    }
    fields.push(field);
    fields
}

fn grok_instances_impl() -> Vec<GrokInstance> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq grok.exe", "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| {
                        let fields = parse_tasklist_csv_line(line);
                        if fields
                            .first()
                            .map(|name| name.eq_ignore_ascii_case("grok.exe"))
                            == Some(true)
                        {
                            fields
                                .get(1)?
                                .parse::<u32>()
                                .ok()
                                .map(|pid| GrokInstance { pid })
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

fn grok_cli_running() -> bool {
    !grok_instances_impl().is_empty()
}

#[tauri::command]
fn grok_instances() -> Vec<GrokInstance> {
    grok_instances_impl()
}

#[tauri::command]
fn close_grok_instances() -> Result<(), String> {
    stop_grok_cli()
}

fn stop_grok_cli() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = Command::new("taskkill")
            .args(["/F", "/IM", "grok.exe", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("Could not close Grok CLI: {error}"))?;
        if !output.status.success() && grok_cli_running() {
            return Err(format!(
                "Could not close Grok CLI: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn switch_profile(profile_id: String, close_running: bool) -> Result<(), String> {
    if grok_cli_running() {
        if !close_running {
            return Err("Close the running Grok session before switching".into());
        }
        stop_grok_cli()?;
    }
    let mut store = load_store()?;
    let profile = store
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or("Profile not found")?;
    normalized_auth(&profile.raw_auth_json)?;
    let expected = fingerprint(&profile.raw_auth_json)?;
    atomic_write(&live_auth_path()?, profile.raw_auth_json.as_bytes())?;
    let written = read_live_auth()?.ok_or("The live auth file disappeared after switching")?;
    if fingerprint(&written)? != expected {
        return Err("Switch verification failed; the live auth file does not match".into());
    }
    profile.last_used_at = Some(Utc::now());
    save_store(&store)?;
    Ok(())
}

#[tauri::command]
fn rename_profile(profile_id: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    let mut store = load_store()?;
    let profile = store
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or("Profile not found")?;
    profile.name = name.to_string();
    save_store(&store)
}

#[tauri::command]
fn delete_profile(profile_id: String) -> Result<(), String> {
    let mut store = load_store()?;
    let original_len = store.profiles.len();
    store.profiles.retain(|profile| profile.id != profile_id);
    if store.profiles.len() == original_len {
        return Err("Profile not found".into());
    }
    save_store(&store)
}

#[tauri::command]
fn launch_grok_login() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args([
                "/C",
                "start",
                "",
                "powershell",
                "-NoExit",
                "-Command",
                "grok login",
            ])
            .spawn()
            .map_err(|error| format!("Could not launch grok login: {error}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("Automatic terminal launch is currently available on Windows only".into());
    }
    Ok(())
}

#[tauri::command]
fn launch_grok() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args([
                "/C",
                "start",
                "",
                "powershell",
                "-NoExit",
                "-Command",
                "grok",
            ])
            .spawn()
            .map_err(|error| format!("Could not launch grok: {error}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("Automatic terminal launch is currently available on Windows only".into());
    }
    Ok(())
}

fn find_number(value: &Value, keys: &[&str]) -> Option<f64> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(candidate) = object.get(*key) {
                    if let Some(value) = candidate.as_f64() {
                        return Some(value);
                    }
                    if let Some(value) = candidate.get("val").and_then(Value::as_f64) {
                        return Some(value);
                    }
                }
            }
            object.values().find_map(|value| find_number(value, keys))
        }
        Value::Array(items) => items.iter().find_map(|value| find_number(value, keys)),
        _ => None,
    }
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn find_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(candidate) = object.get(*key).and_then(Value::as_str) {
                    if !candidate.trim().is_empty() {
                        return Some(candidate.to_string());
                    }
                }
            }
            object.values().find_map(|value| find_string(value, keys))
        }
        Value::Array(items) => items.iter().find_map(|value| find_string(value, keys)),
        _ => None,
    }
}

fn period_label(period_type: Option<&str>) -> Option<String> {
    match period_type {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => Some("Weekly Build limit".into()),
        Some("USAGE_PERIOD_TYPE_MONTHLY") => Some("Monthly credits".into()),
        Some(value) if !value.trim().is_empty() => Some(value.replace("USAGE_PERIOD_TYPE_", "")),
        _ => None,
    }
}

#[tauri::command]
async fn get_profile_usage(profile_id: String) -> Result<UsageView, String> {
    let store = load_store()?;
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or("Profile not found")?;
    let token = access_token(&profile.raw_auth_json).ok_or("Re-login required")?;
    let client = reqwest::Client::new();
    let response = client
        .get(BILLING_CREDITS_URL)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Usage request failed: {error}"))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(UsageView {
            profile_id,
            used: None,
            limit: None,
            percent: None,
            label: "Re-login".into(),
            period_label: None,
            resets_at: None,
            source: "unavailable".into(),
            error: Some("Credentials expired or were revoked".into()),
        });
    }
    if !response.status().is_success() {
        return Err(format!("Usage service returned {}", response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Usage response was invalid: {error}"))?;
    let weekly_percent = find_number(&body, &["creditUsagePercent"]);
    let current_period_type = value_at_path(&body, &["config", "currentPeriod", "type"])
        .and_then(Value::as_str)
        .or_else(|| value_at_path(&body, &["currentPeriod", "type"]).and_then(Value::as_str));
    let current_period_end = value_at_path(&body, &["config", "currentPeriod", "end"])
        .and_then(Value::as_str)
        .or_else(|| value_at_path(&body, &["currentPeriod", "end"]).and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| find_string(&body, &["billingPeriodEnd"]));
    let weekly_label = period_label(current_period_type);
    if weekly_percent.is_some() || current_period_type == Some("USAGE_PERIOD_TYPE_WEEKLY") {
        return Ok(UsageView {
            profile_id,
            used: None,
            limit: None,
            percent: weekly_percent.map(|value| value.clamp(0.0, 100.0)),
            label: weekly_percent
                .map(|value| format!("{value:.0}% used"))
                .unwrap_or_else(|| "Usage available".into()),
            period_label: weekly_label,
            resets_at: current_period_end,
            source: "weekly".into(),
            error: None,
        });
    }

    let response = client
        .get(BILLING_URL)
        .bearer_auth(access_token(&profile.raw_auth_json).ok_or("Re-login required")?)
        .send()
        .await
        .map_err(|error| format!("Usage request failed: {error}"))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(UsageView {
            profile_id,
            used: None,
            limit: None,
            percent: None,
            label: "Re-login".into(),
            period_label: None,
            resets_at: None,
            source: "unavailable".into(),
            error: Some("Credentials expired or were revoked".into()),
        });
    }
    if !response.status().is_success() {
        return Err(format!("Usage service returned {}", response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Usage response was invalid: {error}"))?;
    let used = find_number(&body, &["used", "usage", "amount_used", "spent"]);
    let limit = find_number(
        &body,
        &["monthlyLimit", "limit", "quota", "total", "amount_limit"],
    );
    let percent = match (used, limit) {
        (Some(used), Some(limit)) if limit > 0.0 => Some((used / limit * 100.0).clamp(0.0, 100.0)),
        _ => None,
    };
    Ok(UsageView {
        profile_id,
        used,
        limit,
        percent,
        label: percent
            .map(|value| format!("{value:.0}% used"))
            .unwrap_or_else(|| "Usage available".into()),
        period_label: Some("Monthly credits".into()),
        resets_at: find_string(&body, &["billingPeriodEnd"]),
        source: "monthly".into(),
        error: None,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

        let app_id: Vec<u16> = std::ffi::OsStr::new("com.charles.hydra.desktop")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let _ = SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Hydra", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Hydra - Many Heads. One Command.")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            login_status,
            import_current_profile,
            import_profile_file,
            switch_profile,
            rename_profile,
            delete_profile,
            launch_grok_login,
            launch_grok,
            get_profile_usage,
            grok_instances,
            close_grok_instances
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hydra");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_auth_key_order() {
        let left = r#"{"b":2,"a":{"y":1,"x":0}}"#;
        let right = r#"{"a":{"x":0,"y":1},"b":2}"#;
        assert_eq!(fingerprint(left).unwrap(), fingerprint(right).unwrap());
    }

    #[test]
    fn extracts_nested_identity_and_token() {
        let raw = r#"{"provider":{"email":"person@example.com","key":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"}}"#;
        assert_eq!(auth_email(raw).as_deref(), Some("person@example.com"));
        assert!(access_token(raw).is_some());
    }

    #[test]
    fn reads_wrapped_billing_numbers() {
        let billing = serde_json::json!({
            "config": {
                "monthlyLimit": { "val": 100 },
                "used": { "val": 25 }
            }
        });
        assert_eq!(find_number(&billing, &["used"]), Some(25.0));
        assert_eq!(
            find_number(&billing, &["monthlyLimit", "limit"]),
            Some(100.0)
        );
    }
}
