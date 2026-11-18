//! Lightning fork: hold a WebRTC stream without closing it.
//!
//! The Lightning Launcher hides the picture from its guests while the host is away from the
//! game. Closing the stream and opening a new one when the host came back took 10 s or more
//! (probe, new stream, new connection). Paused, the stream stays connected and no video frame
//! leaves this server; on resume the next frame sent is a key frame (an IDR asked right away),
//! so the picture is back in a fraction of a second.
//!
//! `POST /api/host/stream/webrtc/<id>/pause` with the body `1` (pause) or `0` (resume). Never
//! for a request marked view-only: the guest's own requests carry that header, and a guest
//! must not be able to lift its own pause.

use std::time::{Duration, Instant};

use actix_web::{
    HttpRequest, HttpResponse, post,
    web::{Data, Path},
};
use tracing::info;

use crate::{
    api::stream::webrtc::view_only,
    app::{
        App, AppError,
        stream::{ExternalStreamEvent, StreamId},
        user::AuthenticatedUser,
    },
};

/// While waiting for the key frame after a resume, ask again this often (a request can be lost)
const RESUME_IDR_RETRY: Duration = Duration::from_millis(1000);

#[post("/{stream_id}/pause")]
pub async fn webrtc_pause_post(
    app: Data<App>,
    mut user: AuthenticatedUser,
    stream_id: Path<u32>,
    req: HttpRequest,
    body: String,
) -> Result<HttpResponse, AppError> {
    if view_only::requested(&req) {
        return Err(AppError::Forbidden);
    }
    let paused = match body.trim() {
        "1" => true,
        "0" => false,
        _ => return Ok(HttpResponse::BadRequest().finish()),
    };

    let stream_id = StreamId(stream_id.into_inner());
    let stream = app.stream_by_id(stream_id).await?;
    stream
        .send_event(&mut user, ExternalStreamEvent::SetPaused(paused))
        .await?;
    info!(stream_id = ?stream_id, paused, "stream pause changed");

    Ok(HttpResponse::NoContent().finish())
}

/// What to do with a video frame.
#[derive(Debug, PartialEq, Eq)]
pub enum FrameDecision {
    Send,
    Drop,
    /// Drop it and ask the host for a key frame
    DropAndRequestIdr,
}

/// Decides, frame by frame, what a paused (or just resumed) stream sends.
#[derive(Default)]
pub struct PauseGate {
    waiting_for_key_frame: bool,
    last_request: Option<Instant>,
}

impl PauseGate {
    pub fn on_video_frame(
        &mut self,
        paused: bool,
        is_key_frame: impl FnOnce() -> bool,
        now: Instant,
    ) -> FrameDecision {
        if paused {
            self.waiting_for_key_frame = true;
            self.last_request = None;
            return FrameDecision::Drop;
        }
        if !self.waiting_for_key_frame {
            return FrameDecision::Send;
        }
        // The frames after the pause reference ones that were never sent: only a key frame
        // starts the picture again
        if is_key_frame() {
            self.waiting_for_key_frame = false;
            self.last_request = None;
            return FrameDecision::Send;
        }
        if self
            .last_request
            .is_none_or(|t| now.duration_since(t) >= RESUME_IDR_RETRY)
        {
            self.last_request = Some(now);
            return FrameDecision::DropAndRequestIdr;
        }
        FrameDecision::Drop
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_sent_while_paused() {
        let mut gate = PauseGate::default();
        let now = Instant::now();
        assert_eq!(
            gate.on_video_frame(false, || false, now),
            FrameDecision::Send
        );
        assert_eq!(gate.on_video_frame(true, || true, now), FrameDecision::Drop);
        assert_eq!(
            gate.on_video_frame(true, || false, now),
            FrameDecision::Drop
        );
    }

    #[test]
    fn resume_waits_for_a_key_frame() {
        let mut gate = PauseGate::default();
        let now = Instant::now();
        gate.on_video_frame(true, || false, now);
        assert_eq!(
            gate.on_video_frame(false, || false, now),
            FrameDecision::DropAndRequestIdr
        );
        assert_eq!(
            gate.on_video_frame(false, || false, now),
            FrameDecision::Drop
        );
        assert_eq!(
            gate.on_video_frame(false, || false, now + RESUME_IDR_RETRY),
            FrameDecision::DropAndRequestIdr
        );
        assert_eq!(
            gate.on_video_frame(false, || true, now),
            FrameDecision::Send
        );
        assert_eq!(
            gate.on_video_frame(false, || false, now),
            FrameDecision::Send
        );
    }
}
