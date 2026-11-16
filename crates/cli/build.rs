use std::process::Command;

fn main() {
    let sha = std::env::var("LOO_BUILD_SHA").unwrap_or_else(|_| git_sha());
    println!("cargo:rustc-env=LOO_BUILD_SHA={sha}");
    println!("cargo:rerun-if-env-changed=LOO_BUILD_SHA");
}

fn git_sha() -> String {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let head = git(&dir, &["rev-parse", "--short=12", "HEAD"]);
    let Some(mut sha) = head else {
        return "unknown".into();
    };
    if git(&dir, &["status", "--porcelain"]).is_some_and(|status| !status.is_empty()) {
        sha.push_str("-dirty");
    }
    sha
}

fn git(dir: &str, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_string())
}
