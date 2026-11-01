//! The `Content-Encoding` a response is served under: gzip when the request's
//! `Accept-Encoding` takes it, and the body as it is otherwise.
//!
//! One rule for every route, the event streams included. A stream is the reason
//! this module exists rather than a stock compression layer: a subscription's
//! frames are the bulk of what a live tab receives, and a compressor that holds
//! output until its buffer fills would hold a frame back until the next ones
//! arrived. So a `text/event-stream` body is sync-flushed after every chunk the
//! stream yields, which is one frame or one keep-alive: each arrives as soon as
//! it would have unencoded, and decodes on its own. Any other body is
//! compressed as it streams and finished when it ends.
//!
//! A client that does not ask is served exactly what it was before, and a
//! body known to be empty, such as a `204`'s, is never encoded.

use std::io::Write;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::{Body, BodyDataStream, Bytes, HttpBody};
use axum::extract::Request;
use axum::http::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, VARY,
};
use axum::middleware::Next;
use axum::response::Response;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_core::Stream;

/// Serve the response `next` makes gzip-encoded when the request takes gzip.
pub async fn negotiate(request: Request, next: Next) -> Response {
    let gzip = accepts_gzip(request.headers());
    let mut response = next.run(request).await;
    // Whatever was served depends on the header, for a cache between the two.
    response
        .headers_mut()
        .append(VARY, HeaderValue::from_static("accept-encoding"));
    if !gzip || response.body().size_hint().exact() == Some(0) {
        return response;
    }
    let per_frame = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(CONTENT_LENGTH);
    parts
        .headers
        .insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    let body = Body::from_stream(Gzipped {
        inner: body.into_data_stream(),
        encoder: Some(GzEncoder::new(Vec::new(), Compression::default())),
        per_frame,
    });
    Response::from_parts(parts, body)
}

/// Whether `Accept-Encoding` takes gzip: named with a non-zero weight, or
/// covered by `*` when it is not refused by name. A coding whose weight is not
/// one RFC 9110 spells is not an offer at all, so it neither takes nor refuses.
fn accepts_gzip(headers: &HeaderMap) -> bool {
    let mut named = None;
    let mut any = None;
    for value in headers.get_all(ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else {
            continue;
        };
        for coding in value.split(',') {
            let mut parameters = coding.split(';');
            let name = parameters.next().unwrap_or_default().trim();
            let mut weight = Some(1000);
            for parameter in parameters {
                if let Some((key, value)) = parameter.split_once('=') {
                    if key.trim().eq_ignore_ascii_case("q") {
                        weight = thousandths(value.trim());
                    }
                }
            }
            let Some(weight) = weight else {
                continue;
            };
            let takes = weight > 0;
            if name.eq_ignore_ascii_case("gzip") || name.eq_ignore_ascii_case("x-gzip") {
                named = Some(takes);
            } else if name == "*" {
                any = Some(takes);
            }
        }
    }
    named.or(any).unwrap_or(false)
}

/// A `qvalue` in thousandths: `0` to `1` with at most three decimals, and
/// nothing above `1`. `None` for anything else.
fn thousandths(text: &str) -> Option<u16> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    if fraction.len() > 3 || !fraction.bytes().all(|digit| digit.is_ascii_digit()) {
        return None;
    }
    let fraction: u16 = format!("{fraction:0<3}").parse().ok()?;
    match whole {
        "0" => Some(fraction),
        "1" if fraction == 0 => Some(1000),
        _ => None,
    }
}

/// A body, gzip-encoded as it streams.
struct Gzipped {
    inner: BodyDataStream,
    /// `None` once the body ended and the encoder's trailer was sent.
    encoder: Option<GzEncoder<Vec<u8>>>,
    /// Sync-flush after every chunk, so each is sent as it arrives.
    per_frame: bool,
}

impl Stream for Gzipped {
    type Item = std::io::Result<Bytes>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            let Some(encoder) = this.encoder.as_mut() else {
                return Poll::Ready(None);
            };
            match Pin::new(&mut this.inner).poll_next(cx) {
                Poll::Ready(Some(Ok(chunk))) => {
                    let written = encoder.write_all(&chunk).and_then(|()| {
                        if this.per_frame {
                            encoder.flush()
                        } else {
                            Ok(())
                        }
                    });
                    if let Err(failed) = written {
                        this.encoder = None;
                        return Poll::Ready(Some(Err(failed)));
                    }
                    let out = std::mem::take(encoder.get_mut());
                    // Deflate may hold a chunk until it has more to work with;
                    // a chunk it emitted nothing for is waited past.
                    if !out.is_empty() {
                        return Poll::Ready(Some(Ok(Bytes::from(out))));
                    }
                }
                Poll::Ready(Some(Err(failed))) => {
                    this.encoder = None;
                    return Poll::Ready(Some(Err(std::io::Error::other(failed))));
                }
                Poll::Ready(None) => {
                    let finished = this.encoder.take().map(GzEncoder::finish);
                    return Poll::Ready(match finished {
                        Some(Ok(out)) => Some(Ok(Bytes::from(out))),
                        Some(Err(failed)) => Some(Err(failed)),
                        None => None,
                    });
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT_ENCODING,
            HeaderValue::from_str(value).expect("a value"),
        );
        headers
    }

    #[test]
    fn gzip_is_taken_when_named_or_covered_and_never_when_refused() {
        for taken in [
            "gzip",
            "gzip, deflate, br, zstd",
            "br;q=1.0, gzip;q=0.8",
            "*",
            "x-gzip",
            "gzip; Q=0.001",
            "gzip;q=1.000",
            "gzip;q=2, *",
        ] {
            assert!(accepts_gzip(&headers(taken)), "{taken}");
        }
        for refused in [
            "identity",
            "br",
            "gzip;q=0",
            "*, gzip;q=0",
            "gzip;q=0.0, *",
            "gzip;q=2",
            "gzip;q=1.5",
            "gzip;q=1.001",
            "gzip;q=0.0001",
            "gzip;q=-1",
            "gzip;q=inf",
            "gzip;q=NaN",
            "gzip;q=",
            "gzip;q=.5",
        ] {
            assert!(!accepts_gzip(&headers(refused)), "{refused}");
        }
        assert!(!accepts_gzip(&HeaderMap::new()));
    }
}
