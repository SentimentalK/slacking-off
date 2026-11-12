//! `cargo build` and `cargo test` must work without a web build: when
//! `web/dist` is absent, drop a placeholder index there before `include_dir`
//! reads it. `npm run build` overwrites the placeholder with the real SPA.
//!
//! `include_dir!` reads the files at compile time, which Cargo cannot track on
//! its own. The stamp below changes with any file's name, size or mtime and is
//! passed through `rustc-env`, so a new `dist` always recompiles the crate.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn main() {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let dist = manifest_dir.join("../../web/dist");
    let index = dist.join("index.html");
    if !index.exists() {
        fs::create_dir_all(&dist).expect("creating web/dist failed");
        fs::write(&index, PLACEHOLDER).expect("writing the placeholder index failed");
    }

    let mut hasher = DefaultHasher::new();
    stamp(&dist, &dist, &mut hasher);
    println!("cargo:rustc-env=LOO_WEB_DIST_STAMP={:x}", hasher.finish());
    println!("cargo:rerun-if-changed={}", index.display());
    println!("cargo:rerun-if-changed={}", dist.display());
}

/// Recursively hash relative paths, sizes and mtimes; also ask Cargo to watch
/// every file, so the build script itself reruns when the SPA changes.
fn stamp(root: &Path, dir: &Path, hasher: &mut DefaultHasher) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        relative.hash(hasher);
        println!("cargo:rerun-if-changed={}", path.display());
        if let Ok(metadata) = entry.metadata() {
            metadata.len().hash(hasher);
            if let Ok(modified) = metadata.modified() {
                if let Ok(since) = modified.duration_since(UNIX_EPOCH) {
                    since.as_nanos().hash(hasher);
                }
            }
            if metadata.is_dir() {
                stamp(root, &path, hasher);
            }
        }
    }
}

const PLACEHOLDER: &str = r#"<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>带薪拉屎 · 网页还没构建</title>
    <style>
      body { background: #1d2433; color: #f4f1e8; font-family: sans-serif;
             display: flex; align-items: center; justify-content: center;
             min-height: 100vh; margin: 0; }
      main { border: 2px solid #3b4a6b; background: #232c42; padding: 24px 28px;
             box-shadow: 0 4px 0 #141926; max-width: 460px; }
      h1 { color: #ffcf40; font-size: 24px; margin: 0 0 12px; }
      code { color: #ffcf40; }
    </style>
  </head>
  <body>
    <main>
      <h1>网页还没有构建</h1>
      <p>在 <code>web/</code> 目录运行 <code>npm run build</code>，然后重新编译服务端。</p>
    </main>
  </body>
</html>
"#;
