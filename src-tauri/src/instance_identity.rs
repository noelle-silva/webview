use std::env;
use std::path::{Path, PathBuf};

const INSTANCE_SUFFIX_ENV: &str = "FW_APP_INSTANCE_SUFFIX";
const CF_INSTANCE_SUFFIX_ENV: &str = "EUCLI_CF_INSTANCE_SUFFIX";
const DATA_DIR_OVERRIDE_ENV: &str = "FW_APP_DATA_DIR_OVERRIDE";
const CF_DATA_ROOT_ENV: &str = "EUCLI_CF_DATA_ROOT";

pub(crate) fn resolve_desktop_identifier(base: &str) -> Result<String, String> {
    let raw = read_first_env(&[INSTANCE_SUFFIX_ENV, CF_INSTANCE_SUFFIX_ENV]);
    resolve_desktop_identifier_from_value(base, raw.as_deref())
}

pub(crate) fn resolve_data_dir_override() -> Result<Option<PathBuf>, String> {
    let raw = read_first_env(&[DATA_DIR_OVERRIDE_ENV, CF_DATA_ROOT_ENV]);
    resolve_data_dir_override_from_value(raw.as_deref())
}

pub(crate) fn configure_isolated_webview_dir(data_dir_override: Option<&Path>) {
    let Some(base_dir) = data_dir_override else {
        return;
    };
    if env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return;
    }
    let webview_dir = base_dir.join("webview2");
    let _ = std::fs::create_dir_all(&webview_dir);
    env::set_var("WEBVIEW2_USER_DATA_FOLDER", webview_dir);
}

fn read_first_env(keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Ok(value) = env::var(key) {
            return Some(value);
        }
    }
    None
}

fn resolve_desktop_identifier_from_value(
    base: &str,
    raw_suffix: Option<&str>,
) -> Result<String, String> {
    let Some(raw) = raw_suffix else {
        return Ok(base.to_string());
    };
    let suffix = raw.trim();
    if !is_valid_suffix(suffix) {
        return Err(format!(
            "注入的实例身份后缀 {raw:?} 不合法（仅允许字母/数字开头，且只含字母、数字、点、下划线、连字符），拒绝回退到正式身份"
        ));
    }
    Ok(format!("{base}.{suffix}"))
}

fn resolve_data_dir_override_from_value(raw_dir: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw_dir else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("注入的数据目录覆盖路径为空，拒绝回退到正式数据目录".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!(
            "注入的数据目录覆盖路径 {raw:?} 不是绝对路径，拒绝回退到正式数据目录"
        ));
    }
    Ok(Some(path))
}

fn is_valid_suffix(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_base_identifier_when_suffix_absent() {
        assert_eq!(
            resolve_desktop_identifier_from_value("com.fastwindow.euclistudio", None).unwrap(),
            "com.fastwindow.euclistudio"
        );
    }

    #[test]
    fn appends_valid_suffix() {
        assert_eq!(
            resolve_desktop_identifier_from_value("com.fastwindow.euclistudio", Some("001-adapter"))
                .unwrap(),
            "com.fastwindow.euclistudio.001-adapter"
        );
    }

    #[test]
    fn rejects_invalid_suffix_without_fallback() {
        assert!(resolve_desktop_identifier_from_value("com.fastwindow.euclistudio", Some("")).is_err());
        assert!(
            resolve_desktop_identifier_from_value("com.fastwindow.euclistudio", Some("../prod"))
                .is_err()
        );
        assert!(
            resolve_desktop_identifier_from_value("com.fastwindow.euclistudio", Some("bad suffix"))
                .is_err()
        );
    }

    #[test]
    fn rejects_empty_or_relative_data_dir_override() {
        assert!(resolve_data_dir_override_from_value(Some("  ")).is_err());
        assert!(resolve_data_dir_override_from_value(Some("relative/path")).is_err());
        assert_eq!(resolve_data_dir_override_from_value(None).unwrap(), None);
    }
}
