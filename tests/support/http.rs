//! A client that speaks HTTP over a socket, for journeys that must be real.
//!
//! Hand-rolled rather than borrowed: a client library would decide for these
//! tests what a non-2xx means, when to give up on a body, and how much of a
//! stream to buffer — and every one of those is what the journeys assert. This
//! writes the request bytes and reads the response bytes, so the status, the
//! headers, the chunked framing, and the SSE frames are all the server's own.

#![allow(dead_code)] // Each test binary uses the part of the client it needs.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// How long any single read may block before the journey is declared hung.
const TIMEOUT: Duration = Duration::from_secs(20);

/// One complete response.
pub struct Response {
    /// The status line's code.
    pub status: u16,
    /// The body, decoded.
    pub body: String,
}

impl Response {
    /// The body as JSON. Panics with the body when it is not, because a journey
    /// that got HTML or a stack trace should say so rather than say "invalid".
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|err| panic!("{err}: the body was {:?}", self.body))
    }
}

fn connect(address: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect(address).expect("the server accepts connections");
    stream
        .set_read_timeout(Some(TIMEOUT))
        .expect("read timeout");
    stream
}

fn request(address: SocketAddr, path: &str, headers: &[(&str, &str)]) -> BufReader<TcpStream> {
    let mut stream = connect(address);
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .expect("write the request");
    stream.flush().expect("flush the request");
    BufReader::new(stream)
}

/// The status line and headers, leaving the reader positioned at the body.
fn head(reader: &mut BufReader<TcpStream>) -> (u16, bool) {
    let mut line = String::new();
    reader.read_line(&mut line).expect("read the status line");
    let status: u16 = line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("not an HTTP status line: {line:?}"));
    let mut chunked = false;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).expect("read a header");
        if header.trim().is_empty() {
            return (status, chunked);
        }
        let lowered = header.to_ascii_lowercase();
        if lowered.starts_with("transfer-encoding:") && lowered.contains("chunked") {
            chunked = true;
        }
    }
}

/// `GET path`, read to completion.
///
/// The request asks the server to close when it is done, so "the whole body" is
/// everything up to end of stream — which is what a client without a
/// `Content-Length` has to do anyway, and what makes this work for both framings.
pub fn get(address: SocketAddr, path: &str) -> Response {
    let mut reader = request(address, path, &[]);
    let (status, chunked) = head(&mut reader);
    let mut raw = Vec::new();
    reader.read_to_end(&mut raw).expect("read the body");
    let body = String::from_utf8_lossy(&raw).into_owned();
    Response {
        status,
        body: if chunked { dechunk(&body) } else { body },
    }
}

/// A chunked body, joined. Sizes are hex, each chunk ends with CRLF, and a zero
/// size ends the body.
fn dechunk(raw: &str) -> String {
    let mut rest = raw;
    let mut out = String::new();
    while let Some((header, tail)) = rest.split_once("\r\n") {
        let Ok(size) = usize::from_str_radix(header.trim(), 16) else {
            break;
        };
        if size == 0 || tail.len() < size {
            break;
        }
        out.push_str(&tail[..size]);
        rest = tail[size..].strip_prefix("\r\n").unwrap_or("");
    }
    out
}

/// One server-sent event, as the client sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// The `id:` line.
    pub id: String,
    /// The `event:` line.
    pub event: String,
    /// The `data:` line.
    pub data: String,
}

impl Frame {
    /// The frame's data as JSON.
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.data)
            .unwrap_or_else(|err| panic!("{err}: the frame data was {:?}", self.data))
    }
}

/// An open `text/event-stream`, read one frame at a time.
///
/// Dropping it closes the socket, which is exactly how a browser navigating away
/// ends a subscription — and what the server's own reader watches for.
pub struct Stream {
    reader: BufReader<TcpStream>,
    /// The status the stream opened with, so a journey can assert a refusal.
    pub status: u16,
    chunked: bool,
    buffered: String,
}

/// Open `path` as a stream, optionally resuming from a `Last-Event-ID`.
pub fn stream(address: SocketAddr, path: &str, last_event_id: Option<&str>) -> Stream {
    let headers: Vec<(&str, &str)> = last_event_id
        .map(|id| vec![("Last-Event-ID", id)])
        .unwrap_or_default();
    let mut reader = request(address, path, &headers);
    let (status, chunked) = head(&mut reader);
    Stream {
        reader,
        status,
        chunked,
        buffered: String::new(),
    }
}

impl Stream {
    /// The next frame, or `None` when the server closed the stream.
    ///
    /// Comments — the keep-alives — are skipped: they are the server proving it
    /// is there, and a client must never have to treat one as a frame.
    pub fn next_frame(&mut self) -> Option<Frame> {
        loop {
            if let Some(frame) = self.take_frame() {
                return Some(frame);
            }
            let mut line = String::new();
            let read = self
                .reader
                .read_line(&mut line)
                .expect("read from the stream");
            if read == 0 {
                return None;
            }
            if self.chunked {
                // A chunk header is a hex size on its own line; the payload
                // lines that follow are the ones this client cares about.
                if usize::from_str_radix(line.trim(), 16).is_ok() {
                    continue;
                }
            }
            self.buffered.push_str(&line);
        }
    }

    /// The next `count` frames, which is what a journey asserts on.
    pub fn frames(&mut self, count: usize) -> Vec<Frame> {
        (0..count)
            .map(|_| self.next_frame().expect("the stream stayed open"))
            .collect()
    }

    fn take_frame(&mut self) -> Option<Frame> {
        let end = self.buffered.find("\n\n")?;
        let block: String = self.buffered.drain(..end + 2).collect();
        let field = |name: &str| {
            block
                .lines()
                .find_map(|line| line.strip_prefix(name))
                .map(|value| value.trim().to_owned())
        };
        // A block with no `data:` is a comment: a keep-alive, not a frame.
        let data = field("data:")?;
        Some(Frame {
            id: field("id:").unwrap_or_default(),
            event: field("event:").unwrap_or_default(),
            data,
        })
    }
}
