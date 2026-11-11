//! Minimal blocking HTTP client. Step 0 speaks plain HTTP + JSON (design §10).

use serde_json::Value;
use std::time::Duration;

pub struct Client {
    base: String,
    token: Option<String>,
}

pub struct RawResponse {
    pub status: u16,
    pub body: String,
}

impl Client {
    pub fn new(base: String, token: Option<String>) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            token,
        }
    }

    pub fn get(&self, path: &str, timeout: Duration) -> Result<RawResponse, String> {
        self.call(false, path, None, timeout)
    }

    pub fn post(&self, path: &str, body: Value, timeout: Duration) -> Result<RawResponse, String> {
        self.call(true, path, Some(body), timeout)
    }

    fn call(
        &self,
        post: bool,
        path: &str,
        body: Option<Value>,
        timeout: Duration,
    ) -> Result<RawResponse, String> {
        let url = format!("{}{}", self.base, path);
        let mut request = if post {
            ureq::post(&url)
        } else {
            ureq::get(&url)
        };
        request = request.timeout(timeout);
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        let result = match body {
            Some(body) => request.send_json(body),
            None => request.call(),
        };
        match result {
            Ok(response) => Ok(RawResponse {
                status: response.status(),
                body: response
                    .into_string()
                    .map_err(|error| format!("reading response: {error}"))?,
            }),
            Err(ureq::Error::Status(status, response)) => Ok(RawResponse {
                status,
                body: response.into_string().unwrap_or_default(),
            }),
            Err(ureq::Error::Transport(error)) => Err(format!("cannot reach {url}: {error}")),
        }
    }
}
